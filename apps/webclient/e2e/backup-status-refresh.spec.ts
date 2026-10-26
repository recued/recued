import { openBackupDisclosure, openBackupCopyDetails } from './helpers/backup-disclosure.js';
import { expect, test, type Page } from '@playwright/test';
import type { ArchiveRemoteBackup } from '@recued/contracts';

type Kind = 'health' | 'integrity';
type RequestKind = Kind | 'watchdog' | 'unattended' | 'history' | 'destinations' | 'save-health' | 'save-integrity' | 'save-watchdog' | 'save-unattended' | 'drills' | 'start-drill' | 'cancel-drill' | 'cleanup-drill' | 'check' | 'retrieve';
type ReplyOutcome = 'success' | 'error' | 'invalid-args' | 'unavailable' | 'mismatch' | 'unconfigured' | 'malformed' | 'applied-error';
const refresh = (page: Page) => page.getByRole('button', { name: 'Refresh backup status', exact: true });
const freshness = (page: Page, kind: Kind) => page.locator(`[data-backup-${kind}-refresh-status]`);
const time = (page: Page, kind: Kind) => page.locator(`[data-backup-${kind}-last-refreshed]`);
const field = (page: Page, kind: Kind) => page.locator(kind === 'health' ? '[data-backup-health-hours]' : '[data-backup-integrity-time]');
const save = (page: Page, kind: Kind) => page.locator(`[data-backup-${kind}-save]`);
const release = (page: Page, kind: RequestKind, index = 0, outcome: ReplyOutcome = 'success') =>
  page.evaluate(({ kind, index, outcome }) => window.__backupStatus.release(kind, index, outcome), { kind, index, outcome });
const count = (page: Page, kind: RequestKind) => page.evaluate(kind => window.__backupStatus.calls.filter(call => call.kind === kind).length, kind);
// These ordering cases deliberately exercise the expanded receipt controls.
const storage = async (page: Page, index = 0) => {
  await release(page, 'destinations', index); await release(page, 'history', index);
  for (const row of await page.locator('[data-remote-backup-id]').all()) await openBackupCopyDetails(row);
};
const open = async (page: Page, ready = true) => {
  await page.goto('/backup-status-refresh-harness.html');
  await page.waitForFunction(() => window.__backupStatus !== undefined);
  await openBackupDisclosure(page, 'tools');
  await storage(page);
  if (ready) {
    await release(page, 'health'); await release(page, 'integrity');
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
  }
};
const activate = async (page: Page) => { await refresh(page).focus(); await page.keyboard.press('Enter'); };
const blockedPolicyRetry = async (page: Page, kind: Kind) => {
  const button = save(page, kind); await expect(button).toBeDisabled(); await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { clickCount: 2 });
  await button.dispatchEvent('click'); expect(await count(page, `save-${kind}`)).toBe(1);
};
const readOnly = async (page: Page) => {
  expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
  expect(await page.evaluate(() => window.__backupStatus.calls.filter(call => call.kind.startsWith('save-')))).toEqual([]);
};
const DOWNLOAD_HANDOFF_NOTE = 'Backup received. Check your browser’s downloads to confirm it was saved.';
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

const recoveryNode = (page: Page, name: string) => page.locator(`[data-drill-${name}]`);
const recoveryRefresh = (page: Page) => page.getByRole('button', { name: 'Refresh recovery receipts', exact: true });
const activateRecoveryRefresh = async (page: Page) => { await recoveryRefresh(page).focus(); await page.keyboard.press('Enter'); };
const openRecovery = async (page: Page, mode: 'empty' | 'running' | 'cleanup' = 'empty') => {
  await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') });
  await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z'));
  await page.goto(`/backup-status-refresh-harness.html?drills=${mode}`);
  await page.waitForFunction(() => window.__backupStatus !== undefined);
  await openBackupDisclosure(page, 'tools');
  await storage(page); await release(page, 'health'); await release(page, 'integrity');
  await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(() => window.__backupStatus.holdRecoveryReads());
  await openBackupCopyDetails(page.locator('[data-remote-backup-id]').first());
  await page.locator('[data-remote-backup-drill]').click();
  await expect(recoveryNode(page, 'words')).toBeEnabled();
};
// Pass the held-read indices when a case has already refreshed or started a test.
const updateRecoveryBackup = async (page: Page, update: Partial<ArchiveRemoteBackup> | null, index = 1, drillRead = 0) => {
  await page.evaluate(update => { window.__backupStatus.setRecoveryBackup(update); window.__backupStatus.refresh(); }, update);
  await storage(page, index); await release(page, 'health', index); await release(page, 'integrity', index); await release(page, 'drills', drillRead);
  await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
};

const monitor = (page: Page, name: string) => page.locator(`[data-backup-watchdog-${name}]`);
const openMonitor = async (page: Page, ready = true) => {
  await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') });
  await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z'));
  await page.goto('/backup-status-refresh-harness.html?watchdog');
  await page.waitForFunction(() => window.__backupStatus !== undefined);
  await openBackupDisclosure(page, 'tools');
  await storage(page); await release(page, 'health'); await release(page, 'integrity');
  if (ready) { await release(page, 'watchdog'); await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); }
};

const schedule = (page: Page, name: string) => page.locator(`[data-unattended-${name}]`);
const openSchedule = async (page: Page, firstSetup = false) => {
  await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') });
  await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z'));
  await page.goto(`/backup-status-refresh-harness.html?schedule=${firstSetup ? 'first' : 'configured'}`);
  await page.waitForFunction(() => window.__backupStatus !== undefined);
  await openBackupDisclosure(page, 'tools');
  await storage(page); await release(page, 'health'); await release(page, 'integrity');
  await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(() => window.__backupStatus.holdScheduleReads());
  await openBackupDisclosure(page, 'schedule');
  if (firstSetup) await schedule(page, 'destination').selectOption('Fixture backup storage');
};

for (const width of [390]) test.describe(`Archive download correlation at ${width}px`, () => {
  const panel = (page: Page) => page.locator('[data-recued-archive-backup-panel]');
  const download = (page: Page) => panel(page).locator('[data-recued-archive-backup-download]');
  const progress = (page: Page) => panel(page).locator('[data-recued-archive-backup-download-progress]');
  const stream = (page: Page) => page.evaluate(() => window.__backupStatus.streamState());
  const bytes = (page: Page, length: number, index = 0) => page.evaluate(({ index, length }) => window.__backupStatus.streamBytes(index, length), { index, length });
  const frame = (page: Page, value: Record<string, unknown>, index = 0) => page.evaluate(({ index, text }) => window.__backupStatus.streamText(index, text), { index, text: JSON.stringify(value) });
  const complete = (page: Page, index = 0) => page.evaluate(index => window.__backupStatus.streamControl(index, 'complete'), index);
  const open = async (page: Page, expiring = false) => {
    await page.setViewportSize({ width, height: 900 }); await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') });
    await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z'));
    await page.goto(`/backup-status-refresh-harness.html?export-download=${expiring ? 'stream-expiring' : 'stream'}&download-bytes=4096`);
    await page.waitForFunction(() => window.__backupStatus !== undefined);
  await openBackupDisclosure(page, 'tools'); await storage(page); await release(page, 'health'); await release(page, 'integrity');
    await expect(panel(page)).toHaveAttribute('data-recued-archive-backup-view', 'export-done');
  };
  const begin = async (page: Page, index = 0) => {
    await download(page).focus(); await page.keyboard.press('Enter'); await expect.poll(async () => (await stream(page)).sockets[index]?.starts).toBe(1);
    await expect(download(page)).toHaveAttribute('aria-busy', 'true');
  };
  const noBackup = async (page: Page, downloads = 1) => {
    const state = await page.evaluate(() => window.__backupStatus.manualState());
    expect(state.exports).toEqual([]); expect(state.statusCalls).toBe(1); expect(state.importCalls).toBe(0); expect(state.downloadCalls).toBe(downloads);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  };

  for (const type of ['download_complete', 'download_error'] as const) test(`ignores another request's ${type} and continues receiving without replacing focused controls`, async ({ page }) => {
    await open(page); await begin(page); await bytes(page, 2048); const original = await download(page).elementHandle(), before = await panel(page).innerText();
    await frame(page, { type, req_id: 'another-request', ...(type === 'download_complete' ? { size_bytes: 2048 } : { reason: 'not_found' }) });
    expect(await panel(page).innerText()).toBe(before); await expect(download(page)).toBeFocused(); expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    expect((await stream(page)).sockets[0]!.closes).toBe(0); expect((await stream(page)).savedBytes).toEqual([]);
    await bytes(page, 2048); await expect(progress(page)).toContainText('Waiting for confirmation…'); await complete(page);
    await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE); await expect(progress(page)).toBeHidden(); await expect(download(page)).toBeFocused();
    expect((await stream(page)).savedBytes).toEqual([4096]); expect((await stream(page)).sockets[0]!.closes).toBe(1); await noBackup(page);
  });

  test('handles only the allowed error without an ID and retries only on an explicit action', async ({ page }) => {
    await open(page); await begin(page);
    for (const value of [{ reason: 'not_found' }, { reason: 'bad_request', req_id: 42 }, { reason: 'bad_request', req_id: null }, { reason: 'bad_request', req_id: '' }]) {
      await frame(page, { type: 'download_error', ...value }); await expect(download(page)).toHaveAttribute('aria-busy', 'true');
    }
    expect((await stream(page)).sockets[0]!.closes).toBe(0); await expect(progress(page)).toHaveText('0 B of 4 KB received · 0%');
    await frame(page, { type: 'download_error', reason: 'bad_request' }); await expect(panel(page)).toContainText('Your server said no to the download.');
    await expect(progress(page)).toBeHidden(); await expect(download(page)).toBeFocused(); expect((await stream(page)).savedBytes).toEqual([]); await noBackup(page);
    await begin(page, 1); await bytes(page, 4096, 1); await complete(page, 1); await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE);
    expect((await stream(page)).savedBytes).toEqual([4096]); await noBackup(page, 2);
  });

  test('does not let unrelated terminal traffic extend the byte inactivity deadline', async ({ page }) => {
    await open(page); await begin(page); await page.clock.runFor(150_000);
    await frame(page, { type: 'download_complete', req_id: 'another-request', size_bytes: 0 });
    await frame(page, { type: 'download_error', req_id: 'another-request', reason: 'read_error' });
    await frame(page, { type: 'download_error', reason: 'not_found' }); await page.clock.runFor(149_999);
    await expect(download(page)).toHaveAttribute('aria-busy', 'true'); await page.clock.runFor(1);
    await expect(panel(page)).toContainText('stopped receiving data'); await expect(download(page)).toBeFocused();
    await complete(page); expect((await stream(page)).savedBytes).toEqual([]); expect((await stream(page)).sockets[0]!.closes).toBe(1); await noBackup(page);
  });

  test('rejects the previous request ID on a new socket after an explicit retry', async ({ page }) => {
    await open(page); await begin(page); const first = (await stream(page)).sockets[0]!.reqId;
    await frame(page, { type: 'download_error', req_id: first, reason: 'read_error' }); await expect(panel(page)).toContainText('The server could not read the backup.');
    await begin(page, 1); const second = (await stream(page)).sockets[1]!.reqId; expect(second).not.toBe(first); await bytes(page, 2048, 1);
    await frame(page, { type: 'download_complete', req_id: first, size_bytes: 2048 }, 1); await frame(page, { type: 'download_error', req_id: first, reason: 'read_error' }, 1);
    await expect(progress(page)).toHaveText('2 KB of 4 KB received · 50%'); await expect(download(page)).toBeFocused(); expect((await stream(page)).savedBytes).toEqual([]);
    await bytes(page, 2048, 1); await complete(page, 1); await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE);
    expect((await stream(page)).savedBytes).toEqual([4096]); expect((await stream(page)).sockets.map(socket => socket.closes)).toEqual([1, 1]); await noBackup(page, 2);
  });

  test('preserves export expiry and cancellation after an unrelated completion', async ({ page }) => {
    await open(page, true); await begin(page); await bytes(page, 2048);
    await frame(page, { type: 'download_complete', req_id: 'another-request', size_bytes: 2048 }); await page.clock.runFor(30_000);
    await expect(panel(page)).toContainText('copy expired'); await expect(progress(page)).toHaveText('2 KB of 4 KB received · 50%');
    const back = panel(page).locator('[data-recued-archive-backup-cancel]'); await back.focus(); await page.keyboard.press('Enter');
    await bytes(page, 2048); await complete(page); await page.clock.runFor(300_000);
    await expect(panel(page)).toHaveAttribute('data-recued-archive-backup-view', 'menu'); await expect(progress(page)).toHaveCount(0);
    expect((await stream(page)).savedBytes).toEqual([]); expect((await stream(page)).sockets[0]!.closes).toBe(1); await noBackup(page);
  });
});

for (const width of [390]) test.describe(`Archive download progress at ${width}px`, () => {
  const panel = (page: Page) => page.locator('[data-recued-archive-backup-panel]');
  const download = (page: Page) => panel(page).locator('[data-recued-archive-backup-download]');
  const progress = (page: Page) => panel(page).locator('[data-recued-archive-backup-download-progress]');
  const stream = (page: Page) => page.evaluate(() => window.__backupStatus.streamState());
  const bytes = (page: Page, length: number, index = 0) => page.evaluate(({ index, length }) => window.__backupStatus.streamBytes(index, length), { index, length });
  const complete = (page: Page, index = 0, sizeBytes?: number) => page.evaluate(({ index, sizeBytes }) => window.__backupStatus.streamControl(index, 'complete', sizeBytes), { index, sizeBytes });
  const open = async (page: Page, mode = 'stream', total = 4096) => {
    await page.setViewportSize({ width, height: 900 }); await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') });
    await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z'));
    await page.goto(`/backup-status-refresh-harness.html?export-download=${mode}&download-bytes=${total}`);
    await page.waitForFunction(() => window.__backupStatus !== undefined);
  await openBackupDisclosure(page, 'tools'); await storage(page); await release(page, 'health'); await release(page, 'integrity');
    await expect(panel(page)).toHaveAttribute('data-recued-archive-backup-view', 'export-done'); await expect(progress(page)).toBeHidden();
  };
  const begin = async (page: Page) => { await download(page).focus(); await page.keyboard.press('Enter'); await expect(progress(page)).toBeVisible(); };
  const noBackup = async (page: Page, downloads = 1) => {
    const state = await page.evaluate(() => window.__backupStatus.manualState());
    expect(state.exports).toEqual([]); expect(state.importCalls).toBe(0); expect(state.statusCalls).toBe(1); expect(state.downloadCalls).toBe(downloads);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  };

  for (const stage of ['credentials', 'handshake'] as const) test(`shows connecting during held ${stage}, then advances byte progress on a slow transfer until terminal confirmation`, async ({ page }) => {
    await open(page, `setup-${stage}`, 4 * 1024 * 1024); await begin(page);
    await expect(download(page)).toHaveText('Connecting…'); await expect(progress(page)).toHaveText('Connecting…');
    expect(await progress(page).getAttribute('aria-valuenow')).toBeNull();
    const originalProgress = await progress(page).elementHandle(), originalButton = await download(page).elementHandle();
    const headlineText = await panel(page).locator('[data-recued-archive-backup-path]').evaluateHandle(node => node.firstChild!);
    await page.clock.runFor(30_000); await expect(progress(page)).toHaveText('Connecting…'); await expect(download(page)).toBeFocused();
    if (stage === 'credentials') await page.evaluate(() => window.__backupStatus.releaseSetupRead(0));
    await expect.poll(async () => (await page.evaluate(() => window.__backupStatus.setupState())).sockets.length).toBe(1);
    await page.evaluate(() => window.__backupStatus.openSetupSocket(0));
    await expect(progress(page)).toHaveText('0 B of 4 MB received · 0%'); await expect(download(page)).toHaveText('Downloading…');
    for (let index = 0; index < 8; index++) {
      await page.clock.runFor(64_000); await bytes(page, 512 * 1024); await expect(progress(page)).toHaveAttribute('aria-valuenow', String(Math.floor((index + 1) / 8 * 100)));
      if (index === 3) {
        await expect(progress(page)).toHaveText('2 MB of 4 MB received · 50%');
        await panel(page).screenshot({ path: test.info().outputPath('download-progress.png') });
      }
    }
    await expect(progress(page)).toHaveText('4 MB of 4 MB received · 100% · Waiting for confirmation…');
    await expect(download(page)).toHaveAttribute('aria-busy', 'true'); await expect(download(page)).toBeFocused();
    expect(await originalProgress!.evaluate(node => node.isConnected)).toBe(true); expect(await originalButton!.evaluate(node => node.isConnected)).toBe(true);
    expect(await headlineText.evaluate(node => node.isConnected)).toBe(true);
    expect((await stream(page)).savedBytes).toEqual([]); await expect(panel(page)).not.toContainText(DOWNLOAD_HANDOFF_NOTE);
    await complete(page); expect((await stream(page)).savedBytes).toEqual([4 * 1024 * 1024]);
    await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE); await expect(progress(page)).toBeHidden(); await expect(download(page)).toBeFocused(); await noBackup(page);
  });

  for (const total of [0, 1024]) test(`shows only received bytes when the size hint is unknown or contradicted (${total})`, async ({ page }) => {
    await open(page, 'stream', total); await begin(page); await bytes(page, 2048);
    await expect(progress(page)).toHaveText('2 KB received'); expect(await progress(page).getAttribute('aria-valuenow')).toBeNull();
    await expect(download(page)).toBeFocused(); expect((await stream(page)).savedBytes).toEqual([]);
    await complete(page); await expect(progress(page)).toBeHidden(); expect((await stream(page)).savedBytes).toEqual([2048]); await noBackup(page);
  });

  test('still rejects a terminal size disagreement at 100 percent and resets progress for an explicit retry', async ({ page }) => {
    await open(page); await begin(page); await bytes(page, 4096); await expect(progress(page)).toContainText('Waiting for confirmation…');
    await complete(page, 0, 4097); await expect(panel(page)).toContainText('The download did not finish.'); await expect(progress(page)).toBeHidden();
    expect((await stream(page)).savedBytes).toEqual([]); await expect(download(page)).toBeFocused(); await begin(page);
    await expect(progress(page)).toHaveText('0 B of 4 KB received · 0%'); await bytes(page, 8192, 0);
    await expect(progress(page)).toHaveText('0 B of 4 KB received · 0%'); await bytes(page, 2048, 1);
    await expect(progress(page)).toHaveText('2 KB of 4 KB received · 50%'); await complete(page, 1);
    await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE); expect((await stream(page)).savedBytes).toEqual([2048]); await noBackup(page, 2);
  });

  test('updates progress across export expiry without replacing nodes or taking focus from Back', async ({ page }) => {
    await open(page, 'stream-expiring'); await begin(page); await bytes(page, 2048);
    const originalProgress = await progress(page).elementHandle(), back = panel(page).locator('[data-recued-archive-backup-cancel]');
    await back.focus(); await page.clock.runFor(30_000); await expect(panel(page)).toContainText('copy expired'); await expect(progress(page)).toContainText('50%');
    await bytes(page, 2048); await expect(progress(page)).toContainText('Waiting for confirmation…'); await expect(back).toBeFocused();
    expect(await originalProgress!.evaluate(node => node.isConnected)).toBe(true); await expect(download(page)).toHaveText('Downloading…');
    await complete(page); await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE); await expect(download(page)).toHaveText('Download expired');
    await expect(back).toBeFocused(); await expect(progress(page)).toBeHidden(); await noBackup(page);
  });
});

for (const width of [390]) test.describe(`Download connection setup at ${width}px`, () => {
  const panel = (page: Page) => page.locator('[data-recued-archive-backup-panel]');
  const download = (page: Page) => panel(page).locator('[data-recued-archive-backup-download]');
  const setup = (page: Page) => page.evaluate(() => window.__backupStatus.setupState());
  const stream = (page: Page) => page.evaluate(() => window.__backupStatus.streamState());
  const manual = (page: Page) => page.evaluate(() => window.__backupStatus.manualState());
  const open = async (page: Page, stage = 'handshake') => {
    await page.setViewportSize({ width, height: 900 }); await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') });
    await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z')); await page.goto(`/backup-status-refresh-harness.html?export-download=setup-${stage}`);
    await page.waitForFunction(() => window.__backupStatus !== undefined);
  await openBackupDisclosure(page, 'tools'); await storage(page); await release(page, 'health'); await release(page, 'integrity');
    await expect(panel(page)).toHaveAttribute('data-recued-archive-backup-view', 'export-done');
  };
  const begin = async (page: Page, count = 1) => { await download(page).focus(); await page.keyboard.press('Enter'); await expect.poll(async () => (await setup(page)).aborted.length).toBe(count); };
  const noBackup = async (page: Page) => { const state = await manual(page); expect(state.exports).toEqual([]); expect(state.importCalls).toBe(0); expect(state.statusCalls).toBe(1); };

  for (const stage of ['credentials', 'handshake'] as const) test(`bounds ${stage} setup, ignores late results and allows an explicit fresh retry`, async ({ page }) => {
    await open(page, stage); await begin(page); await page.clock.runFor(59_999); await expect(download(page)).toHaveText('Connecting…'); await expect(panel(page)).not.toContainText('connection took too long');
    await page.clock.runFor(1); await expect(panel(page)).toContainText('connection took too long'); await expect(download(page)).toHaveAttribute('aria-busy', 'false');
    await expect(download(page)).toHaveAttribute('aria-disabled', 'false'); await expect(download(page)).toBeFocused(); expect((await setup(page)).aborted).toEqual([true]);
    if (stage === 'credentials') { await page.evaluate(() => window.__backupStatus.releaseSetupRead(0)); await page.clock.runFor(0); expect((await stream(page)).sockets).toEqual([]); }
    else { expect((await setup(page)).sockets[0]).toEqual({ state: 3, closes: 1 }); await page.evaluate(() => window.__backupStatus.openSetupSocket(0)); expect((await stream(page)).sockets[0]!.starts).toBe(0); }
    expect((await manual(page)).downloadCalls).toBe(1); await begin(page, 2);
    if (stage === 'credentials') await page.evaluate(() => window.__backupStatus.releaseSetupRead(1));
    const index = stage === 'credentials' ? 0 : 1; await expect.poll(async () => (await setup(page)).sockets.length).toBe(index + 1);
    await page.evaluate(index => window.__backupStatus.openSetupSocket(index), index); await expect.poll(async () => (await stream(page)).sockets[index]!.starts).toBe(1);
    expect((await setup(page)).aborted).toEqual([true, false]); await page.evaluate(index => { window.__backupStatus.streamChunk(index, [4, 5]); window.__backupStatus.streamControl(index, 'complete'); }, index);
    await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE); await expect(download(page)).toBeFocused(); await page.clock.runFor(300_000);
    expect((await stream(page)).savedBytes).toEqual([2]); expect((await manual(page)).downloadCalls).toBe(2); await noBackup(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  for (const stage of ['credentials', 'handshake'] as const) for (const action of ['back', 'dispose'] as const) test(`cancels ${stage} setup on ${action} before a late open or credential reply`, async ({ page }) => {
    await open(page, stage); await begin(page);
    if (action === 'back') { await panel(page).locator('[data-recued-archive-backup-cancel]').focus(); await page.keyboard.press('Enter'); } else await page.evaluate(() => window.__backupStatus.dispose());
    expect((await setup(page)).aborted).toEqual([true]);
    if (stage === 'credentials') await page.evaluate(() => window.__backupStatus.releaseSetupRead(0));
    else { expect((await setup(page)).sockets[0]).toEqual({ state: 3, closes: 1 }); await page.evaluate(() => window.__backupStatus.openSetupSocket(0)); }
    await page.clock.runFor(300_000); expect((await stream(page)).savedBytes).toEqual([]); expect((await stream(page)).sockets.every(socket => socket.starts === 0)).toBe(true);
    if (stage === 'credentials') expect((await setup(page)).sockets).toEqual([]);
    if (action === 'back') { await expect(panel(page)).toHaveAttribute('data-recued-archive-backup-view', 'menu'); await expect(panel(page)).not.toContainText('connection took too long'); } else await expect(panel(page)).toHaveCount(0);
    expect((await manual(page)).downloadCalls).toBe(1); expect((await manual(page)).downloadCancelled).toBe(1); await noBackup(page);
  });

  test('respects expiry while connecting and requires explicit fresh key entry', async ({ page }) => {
    await open(page, 'expiring'); await begin(page); await page.clock.runFor(10_000); await expect(panel(page)).toContainText('copy expired'); await expect(download(page)).toHaveText('Connecting…');
    await page.clock.runFor(50_000); await expect(panel(page)).toContainText('connection took too long'); await expect(download(page)).toHaveText('Download expired');
    await expect(download(page)).toHaveAttribute('aria-disabled', 'true'); await expect(download(page)).toBeFocused(); await page.keyboard.press('Enter'); expect((await manual(page)).downloadCalls).toBe(1);
    await panel(page).locator('[data-recued-archive-backup-another]').focus(); await page.keyboard.press('Enter'); const words = panel(page).locator('[data-recued-archive-backup-mnemonic]');
    await expect(words).toBeFocused(); await expect(words).toHaveValue(''); await noBackup(page);
  });

  test('lets a connection open just before its deadline and then uses the independent byte inactivity timer', async ({ page }) => {
    await open(page); await begin(page); await page.clock.runFor(59_999); await page.evaluate(() => window.__backupStatus.openSetupSocket(0));
    await expect.poll(async () => (await stream(page)).sockets[0]!.starts).toBe(1);
    for (const byte of [1, 2]) { await page.clock.runFor(150_000); await page.evaluate(byte => window.__backupStatus.streamChunk(0, [byte]), byte); await expect(download(page)).toHaveText('Downloading…'); }
    await page.evaluate(() => window.__backupStatus.streamControl(0, 'complete')); await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE); expect((await stream(page)).savedBytes).toEqual([2]); await noBackup(page);
  });

  test('does not steal focus from another control when setup times out', async ({ page }) => {
    await open(page); await begin(page); const outside = page.getByRole('button', { name: 'Outside panel', exact: true }); await outside.focus(); await page.clock.runFor(60_000);
    await expect(panel(page)).toContainText('connection took too long'); await expect(outside).toBeFocused(); await noBackup(page);
  });

  for (const event of ['error', 'close'] as const) test(`ends setup promptly on a pre-open ${event} without a later timeout`, async ({ page }) => {
    await open(page); await begin(page); await page.evaluate(event => window.__backupStatus.streamControl(0, event), event);
    await expect(panel(page)).toContainText('could not start the download'); await expect(download(page)).toHaveAttribute('aria-disabled', 'false'); await expect(download(page)).toBeFocused();
    await page.clock.runFor(300_000); await expect(panel(page)).not.toContainText('connection took too long'); expect((await manual(page)).downloadCalls).toBe(1); expect((await stream(page)).savedBytes).toEqual([]); await noBackup(page);
  });
});

for (const width of [390]) test.describe(`Stalled archive downloads at ${width}px`, () => {
  const panel = (page: Page) => page.locator('[data-recued-archive-backup-panel]');
  const download = (page: Page) => panel(page).locator('[data-recued-archive-backup-download]');
  const manual = (page: Page) => page.evaluate(() => window.__backupStatus.manualState());
  const stream = (page: Page) => page.evaluate(() => window.__backupStatus.streamState());
  const chunk = (page: Page, index: number, values: number[]) => page.evaluate(({ index, values }) => window.__backupStatus.streamChunk(index, values), { index, values });
  const frame = (page: Page, index: number, type: 'complete' | 'noise' | 'error' | 'close') => page.evaluate(({ index, type }) => window.__backupStatus.streamControl(index, type), { index, type });
  const openStream = async (page: Page, expiring = false) => {
    await page.setViewportSize({ width, height: 900 }); await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') });
    await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z')); await page.goto(`/backup-status-refresh-harness.html?export-download=${expiring ? 'stream-expiring' : 'stream'}`);
    await page.waitForFunction(() => window.__backupStatus !== undefined);
  await openBackupDisclosure(page, 'tools'); await storage(page); await release(page, 'health'); await release(page, 'integrity');
    await expect(panel(page)).toHaveAttribute('data-recued-archive-backup-view', 'export-done');
  };
  const begin = async (page: Page, count = 1) => {
    await download(page).focus(); await page.keyboard.press('Enter'); await expect.poll(async () => (await stream(page)).sockets[count - 1]?.starts).toBe(1);
    await expect(download(page)).toHaveAttribute('aria-busy', 'true');
  };
  const noBackup = async (page: Page) => { const state = await manual(page); expect(state.exports).toEqual([]); expect(state.statusCalls).toBe(1); expect(state.importCalls).toBe(0); };

  for (const partial of [false, true]) test(`ends a silent transfer (partial: ${partial}), preserves focus, and retries only on an explicit action`, async ({ page }) => {
    await openStream(page); await begin(page);
    if (partial) { await page.clock.runFor(30_000); await chunk(page, 0, [1, 2, 3]); }
    await page.clock.runFor(299_999); await expect(download(page)).toHaveText('Downloading…'); await expect(panel(page)).not.toContainText('stopped receiving data');
    await page.clock.runFor(1); await expect(panel(page)).toContainText('stopped receiving data'); await expect(download(page)).toHaveAttribute('aria-busy', 'false');
    await expect(download(page)).toHaveAttribute('aria-disabled', 'false'); await expect(download(page)).toBeFocused();
    expect((await stream(page)).sockets[0]!.closes).toBe(1); expect((await stream(page)).savedBytes).toEqual([]); expect((await manual(page)).downloadCalls).toBe(1);
    await frame(page, 0, 'complete'); expect((await stream(page)).savedBytes).toEqual([]); await begin(page, 2);
    await chunk(page, 0, [9]); await frame(page, 0, 'complete'); await frame(page, 0, 'error'); expect((await stream(page)).sockets[1]!.closes).toBe(0);
    await chunk(page, 1, [4, 5]); await frame(page, 1, 'complete'); await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE); await expect(download(page)).toBeFocused();
    await page.clock.runFor(300_000); expect((await stream(page)).savedBytes).toEqual([2]); expect((await stream(page)).sockets.map(row => row.closes)).toEqual([1, 1]);
    expect((await manual(page)).downloadCalls).toBe(2); await noBackup(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('allows a healthy transfer to outlast an idle interval while incoming bytes keep it active', async ({ page }) => {
    await openStream(page); await begin(page);
    for (const value of [1, 2, 3]) { await page.clock.runFor(299_000); await chunk(page, 0, [value]); await expect(download(page)).toHaveText('Downloading…'); expect((await stream(page)).sockets[0]!.closes).toBe(0); }
    await frame(page, 0, 'complete'); await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE); await page.clock.runFor(300_000);
    await expect(panel(page)).not.toContainText('stopped receiving data'); expect((await stream(page)).savedBytes).toEqual([3]); expect((await manual(page)).downloadCalls).toBe(1); await noBackup(page);
  });

  test('accepts 512 KiB chunks arriving 64 seconds apart on a slow link', async ({ page }) => {
    await openStream(page); await begin(page);
    for (let index = 0; index < 2; index++) {
      await page.clock.runFor(64_000); await expect(download(page)).toHaveText('Downloading…'); expect((await stream(page)).sockets[0]!.closes).toBe(0);
      await page.evaluate(() => window.__backupStatus.streamChunk(0, Array.from({ length: 512 * 1024 }, () => 7)));
    }
    await frame(page, 0, 'complete'); await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE); await expect(download(page)).toBeFocused();
    expect((await stream(page)).savedBytes).toEqual([1024 * 1024]); expect((await manual(page)).downloadCalls).toBe(1); await noBackup(page);
  });

  test('does not let empty chunks or unrelated text keep a stalled transfer alive', async ({ page }) => {
    await openStream(page); await begin(page); await page.clock.runFor(150_000); await chunk(page, 0, []); await frame(page, 0, 'noise'); await page.clock.runFor(150_000);
    await expect(panel(page)).toContainText('stopped receiving data'); expect((await stream(page)).sockets[0]!.closes).toBe(1); expect((await stream(page)).savedBytes).toEqual([]); await noBackup(page);
  });

  test('honors local copy expiry when a stalled download fails and opens fresh key entry only explicitly', async ({ page }) => {
    await openStream(page, true); await begin(page); await page.clock.runFor(30_000); await expect(panel(page)).toContainText('copy expired'); await expect(download(page)).toHaveText('Downloading…');
    await page.clock.runFor(270_000); await expect(panel(page)).toContainText('stopped receiving data'); await expect(download(page)).toHaveText('Download expired');
    await expect(download(page)).toHaveAttribute('aria-disabled', 'true'); await expect(download(page)).toBeFocused(); await page.keyboard.press('Enter'); expect((await manual(page)).downloadCalls).toBe(1);
    const another = panel(page).locator('[data-recued-archive-backup-another]'); await another.focus(); await page.keyboard.press('Enter');
    await expect(panel(page).locator('[data-recued-archive-backup-mnemonic]')).toBeFocused(); await expect(panel(page).locator('[data-recued-archive-backup-mnemonic]')).toHaveValue('');
    await frame(page, 0, 'complete'); expect((await stream(page)).savedBytes).toEqual([]); await noBackup(page);
  });

  test('keeps focus on another control when a stalled transfer reports failure', async ({ page }) => {
    await openStream(page); await begin(page); const outside = page.getByRole('button', { name: 'Outside panel', exact: true }); await outside.focus();
    await page.clock.runFor(300_000); await expect(panel(page)).toContainText('stopped receiving data'); await expect(outside).toBeFocused(); await noBackup(page);
  });

  for (const action of ['back', 'dispose'] as const) test(`cancels the watchdog on ${action} and ignores late completion`, async ({ page }) => {
    await openStream(page); await begin(page); const old = await download(page).elementHandle();
    if (action === 'back') { await panel(page).locator('[data-recued-archive-backup-cancel]').focus(); await page.keyboard.press('Enter'); } else await page.evaluate(() => window.__backupStatus.dispose());
    await page.clock.runFor(600_000); await chunk(page, 0, [1, 2]); await frame(page, 0, 'complete'); await old!.evaluate(node => (node as HTMLButtonElement).click());
    if (action === 'back') { await expect(panel(page)).toHaveAttribute('data-recued-archive-backup-view', 'menu'); await expect(panel(page)).not.toContainText('stopped receiving data'); } else await expect(panel(page)).toHaveCount(0);
    expect((await stream(page)).savedBytes).toEqual([]); expect((await stream(page)).sockets[0]!.closes).toBe(1); expect((await manual(page)).downloadCalls).toBe(1); expect((await manual(page)).downloadCancelled).toBe(1); await noBackup(page);
  });
});

for (const width of [390]) test.describe(`Local export download expiry at ${width}px`, () => {
  test.use({ locale: 'en-US', timezoneId: 'UTC' });
  const panel = (page: Page) => page.locator('[data-recued-archive-backup-panel]');
  const download = (page: Page) => panel(page).locator('[data-recued-archive-backup-download]');
  const another = (page: Page) => panel(page).locator('[data-recued-archive-backup-another]');
  const headline = (page: Page) => panel(page).locator('[data-recued-archive-backup-path]');
  const state = (page: Page) => page.evaluate(() => window.__backupStatus.manualState());
  const openDownload = async (page: Page, mode = 'ready') => {
    await page.setViewportSize({ width, height: 900 }); await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') });
    await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z')); await page.goto(`/backup-status-refresh-harness.html?export-download=${mode}`);
    await page.waitForFunction(() => window.__backupStatus !== undefined);
  await openBackupDisclosure(page, 'tools'); await storage(page); await release(page, 'health'); await release(page, 'integrity');
    await expect(panel(page)).toHaveAttribute('data-recued-archive-backup-view', 'export-done'); await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
  };
  const expired = async (page: Page) => {
    await expect(headline(page)).toContainText('copy expired'); await expect(download(page)).toHaveText('Download expired');
    await expect(download(page)).toHaveAttribute('aria-disabled', 'true'); await expect(download(page)).toHaveAttribute('aria-busy', 'false'); await expect(another(page)).toBeVisible();
  };
  const noNewBackup = async (page: Page) => {
    const current = await state(page); expect(current.exports).toEqual([]); expect(current.importCalls).toBe(0); expect(current.statusCalls).toBe(1);
  };

  test('shows an exact deadline and retires its focused action at that instant without requests or replacing it', async ({ page }) => {
    await openDownload(page); await expect(headline(page)).toContainText('download by'); await expect(headline(page)).toContainText('10:14:21'); await expect(headline(page)).toContainText('UTC');
    const original = await download(page).elementHandle(); await download(page).focus();
    await page.clock.runFor(59_999); await expect(download(page)).toHaveAttribute('aria-disabled', 'false'); await page.clock.runFor(1); await expired(page);
    expect(await original!.evaluate(node => node === document.querySelector('[data-recued-archive-backup-download]'))).toBe(true); await expect(download(page)).toBeFocused();
    await page.keyboard.press('Enter'); expect((await state(page)).downloadCalls).toBe(0);
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]); await noNewBackup(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  for (const action of ['keyboard', 'pointer'] as const) test(`checks a suspended tab deadline before a stale ${action} Download activation`, async ({ page }) => {
    await openDownload(page); await download(page).focus(); await page.clock.setSystemTime(new Date((await state(page)).expiresAt!));
    if (action === 'keyboard') await page.keyboard.press('Enter'); else await download(page).click();
    await expired(page); if (action === 'keyboard') await expect(download(page)).toBeFocused();
    await expect(another(page)).not.toBeFocused(); expect((await state(page)).downloadCalls).toBe(0); await noNewBackup(page);
  });

  test('opens empty recovery-key entry only after an explicit Make another backup action', async ({ page }) => {
    await openDownload(page, 'expired'); await expired(page); await another(page).focus(); await page.keyboard.press('Enter');
    const words = panel(page).locator('[data-recued-archive-backup-mnemonic]'); await expect(words).toBeFocused(); await expect(words).toHaveValue('');
    await expect(panel(page)).toHaveAttribute('data-recued-archive-backup-view', 'export-entry'); expect((await state(page)).downloadCalls).toBe(0); await noNewBackup(page);
  });

  for (const outcome of ['done', 'error'] as const) test(`keeps a live download through expiry and its ${outcome} feedback without cancellation or replay`, async ({ page }) => {
    await openDownload(page); await download(page).focus(); await page.keyboard.press('Enter'); const pending = await download(page).elementHandle();
    await page.clock.runFor(60_000); await expect(download(page)).toHaveText('Downloading…'); await expect(download(page)).toBeFocused();
    await expect(headline(page)).toContainText('download already in progress will continue'); expect(await pending!.evaluate(node => node === document.querySelector('[data-recued-archive-backup-download]'))).toBe(true);
    await expect(another(page)).toHaveAttribute('aria-disabled', 'true'); await another(page).focus(); await page.keyboard.press('Enter'); await expect(panel(page)).toHaveAttribute('data-recued-archive-backup-view', 'export-done');
    expect((await state(page)).downloadCancelled).toBe(0); await page.evaluate(outcome => window.__backupStatus.finishManualDownload(outcome), outcome);
    await expired(page); await expect(another(page)).toBeFocused(); await expect(another(page)).toHaveAttribute('aria-disabled', 'false');
    await expect(panel(page)).toContainText(outcome === 'done' ? DOWNLOAD_HANDOFF_NOTE : 'Download failed: fixture connection closed');
    await download(page).focus(); await page.keyboard.press('Enter'); expect((await state(page)).downloadCalls).toBe(1); expect((await state(page)).downloadCancelled).toBe(0); await noNewBackup(page);
  });

  test('keeps completed download feedback when its local copy later expires', async ({ page }) => {
    await openDownload(page); await download(page).click(); await page.evaluate(() => window.__backupStatus.finishManualDownload('done'));
    await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE); const original = await download(page).elementHandle(); await download(page).focus(); await page.clock.runFor(60_000);
    await expired(page); await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE); await expect(download(page)).toBeFocused();
    expect(await original!.evaluate(node => node === document.querySelector('[data-recued-archive-backup-download]'))).toBe(true); expect((await state(page)).downloadCalls).toBe(1); await noNewBackup(page);
  });

  test('does not extend the deadline through a failed download, explicit retry and completion', async ({ page }) => {
    await openDownload(page); const original = (await state(page)).expiresAt; await page.clock.runFor(15_000); await download(page).click();
    await page.clock.runFor(15_000); await page.evaluate(() => window.__backupStatus.finishManualDownload('error')); await download(page).click();
    await page.clock.runFor(15_000); await page.evaluate(() => window.__backupStatus.finishManualDownload('done')); await page.clock.runFor(15_000);
    await expired(page); await expect(panel(page)).toContainText(DOWNLOAD_HANDOFF_NOTE); expect((await state(page)).expiresAt).toBe(original); expect((await state(page)).downloadCalls).toBe(2); await noNewBackup(page);
  });

  test('does not move focus from another settings control when the deadline passes', async ({ page }) => {
    await openDownload(page); await refresh(page).focus(); await page.clock.runFor(60_000); await expired(page); await expect(refresh(page)).toBeFocused(); await noNewBackup(page);
  });

  for (const action of ['back', 'dispose'] as const) test(`cancels expiry and ignores an old Download after ${action}`, async ({ page }) => {
    await openDownload(page); const old = await download(page).elementHandle();
    if (action === 'back') await panel(page).locator('[data-recued-archive-backup-cancel]').click(); else await page.evaluate(() => window.__backupStatus.dispose());
    const before = action === 'back' ? await panel(page).textContent() : null; await page.clock.runFor(60_000); await old!.evaluate(node => (node as HTMLButtonElement).click());
    if (action === 'back') expect(await panel(page).textContent()).toBe(before); else await expect(panel(page)).toHaveCount(0);
    expect((await state(page)).downloadCalls).toBe(0); await noNewBackup(page);
  });

  test('retains remote delivery history when the server reports no local download copy', async ({ page }) => {
    await openDownload(page, 'remote-only'); await expect(headline(page)).toContainText('Remote delivery was verified'); await expect(download(page)).toHaveCount(0);
    await expect(another(page)).toBeHidden(); await page.clock.runFor(60_000); await expect(headline(page)).not.toContainText('copy expired'); await noNewBackup(page);
  });

  test('keeps legacy downloads available when the server supplies no deadline', async ({ page }) => {
    await openDownload(page, 'unknown'); await page.clock.runFor(60_000); await expect(download(page)).toHaveAttribute('aria-disabled', 'false'); await expect(another(page)).toBeHidden();
    await download(page).click(); expect((await state(page)).downloadCalls).toBe(1); await noNewBackup(page);
  });

  test('retires a server-path-only copy and still offers an explicit new backup entry', async ({ page }) => {
    await openDownload(page, 'server-path'); await expect(download(page)).toHaveCount(0); await page.clock.runFor(60_000); await expect(headline(page)).toContainText('copy expired');
    await another(page).click(); await expect(panel(page).locator('[data-recued-archive-backup-mnemonic]')).toBeFocused(); await noNewBackup(page);
  });
});

for (const width of [390]) test.describe(`Stored copy check ordering at ${width}px`, () => {
  const row = (page: Page) => page.locator('[data-remote-backup-id="12345678-1234-4234-8234-123456789abc"]');
  const check = (page: Page) => page.locator('[data-remote-backup-check]');
  const prepare = (page: Page) => page.locator('[data-remote-backup-restore]');
  const drill = (page: Page) => page.locator('[data-remote-backup-drill]');
  const activateCheck = async (page: Page) => { await check(page).focus(); await page.keyboard.press('Enter'); };
  const openCheck = async (page: Page, state: 'verified' | 'unconfirmed' = 'verified') => {
    await page.setViewportSize({ width, height: 900 }); await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') });
    await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z')); await page.goto('/backup-status-refresh-harness.html?drills=empty');
    await page.waitForFunction(() => window.__backupStatus !== undefined);
  await openBackupDisclosure(page, 'tools'); await page.evaluate(state => window.__backupStatus.setRecoveryBackup({ state }), state);
    await storage(page); await release(page, 'health'); await release(page, 'integrity'); await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
    await page.evaluate(() => window.__backupStatus.holdRecoveryReads());
  };
  const currentRead = async (page: Page, index: number, drillRead = 0) => {
    await storage(page, index); await release(page, 'health', index); await release(page, 'integrity', index); await release(page, 'drills', drillRead);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
  };

  for (const initial of ['verified', 'unconfirmed'] as const) for (const oldFirst of [true, false]) for (const outcome of ['success', 'error'] as const) {
    test(`preserves a check over older ${initial} ${outcome} history (old first: ${oldFirst}) and reconciles once`, async ({ page }) => {
      await openCheck(page, initial); await page.evaluate(() => window.__backupStatus.refresh());
      if (outcome === 'success') await release(page, 'history', 1);
      await page.evaluate(() => window.__backupStatus.setRecoveryBackup({ state: 'verifying' })); await activateCheck(page);
      await expect(refresh(page)).toHaveAttribute('aria-busy', 'true'); await expect(refresh(page)).toContainText('Waiting');
      await page.evaluate(() => { window.__backupStatus.refresh(); window.__backupStatus.refresh(); }); expect(await count(page, 'history')).toBe(2);
      const finishOld = async () => {
        await release(page, 'destinations', 1); if (outcome === 'error') await release(page, 'history', 1, 'error');
        await release(page, 'health', 1); await release(page, 'integrity', 1);
      };
      if (oldFirst) { await finishOld(); await expect(row(page)).toContainText('Checking the stored copy…'); }
      await release(page, 'check'); await expect(row(page)).toHaveAttribute('data-remote-backup-state', 'verifying');
      if (!oldFirst) await finishOld();
      await expect(row(page)).toHaveAttribute('data-remote-backup-state', 'verifying'); await expect(check(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(prepare(page)).toHaveAttribute('aria-disabled', 'true'); await expect(drill(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(check(page)).toBeFocused(); expect(await count(page, 'history')).toBe(2); expect(await count(page, 'check')).toBe(1);
      await expect(page.locator('[data-remote-backups-status]')).not.toContainText('could not be checked');
      await page.evaluate(() => window.__backupStatus.setRecoveryBackup({ state: 'verified' })); await page.clock.runFor(250);
      expect(await count(page, 'history')).toBe(3); expect(await count(page, 'destinations')).toBe(3);
      await currentRead(page, 2); await expect(row(page)).toHaveAttribute('data-remote-backup-state', 'verified');
      await expect(check(page)).toHaveAttribute('aria-disabled', 'false'); await expect(prepare(page)).toHaveAttribute('aria-disabled', 'false');
      await expect(drill(page)).toHaveAttribute('aria-disabled', 'false'); await expect(check(page)).toBeFocused();
      expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['check']);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  test('blocks an uncertain check through a failed reconciliation read and permits only an explicit retry after recovery', async ({ page }) => {
    await openCheck(page); await activateCheck(page); await release(page, 'check', 0, 'error');
    const warning = row(page).getByRole('status').filter({ hasText: 'stored copy check could not be confirmed' }); await expect(warning).toBeVisible();
    await expect(check(page)).toHaveAttribute('aria-disabled', 'true'); await expect(prepare(page)).toHaveAttribute('aria-disabled', 'true'); await expect(drill(page)).toHaveAttribute('aria-disabled', 'true');
    await page.clock.runFor(250); await release(page, 'destinations', 1); await release(page, 'history', 1, 'error'); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); await expect(page.locator('[data-remote-backups-status]')).toContainText('could not be checked');
    await check(page).dispatchEvent('click'); await check(page).dispatchEvent('click'); expect(await count(page, 'check')).toBe(1); await expect(warning).toBeVisible();
    await activate(page); await currentRead(page, 2); await expect(check(page)).toHaveAttribute('aria-disabled', 'false'); await expect(warning).toBeVisible(); await expect(refresh(page)).toBeFocused();
    expect(await count(page, 'check')).toBe(1); await page.evaluate(() => window.__backupStatus.setRecoveryBackup({ state: 'verifying' }));
    await activateCheck(page); await release(page, 'check', 1); await expect(row(page)).toHaveAttribute('data-remote-backup-state', 'verifying');
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['check', 'check']); await expect(page.locator('[data-remote-backups]')).not.toContainText('private provider');
  });

  for (const outcome of ['success', 'error'] as const) test(`ignores a late ${outcome} check after disposal without starting another read`, async ({ page }) => {
    await openCheck(page); await activateCheck(page); await page.evaluate(() => window.__backupStatus.dispose());
    const before = await page.locator('[data-remote-backups]').textContent(); await release(page, 'check', 0, outcome); await page.clock.runFor(1_000);
    await expect.poll(() => page.locator('[data-remote-backups]').textContent()).toBe(before); await check(page).dispatchEvent('click');
    expect(await count(page, 'history')).toBe(1); expect(await count(page, 'check')).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['check']);
  });
});

for (const width of [390]) test.describe(`Restore preview preparation expiry at ${width}px`, () => {
  const button = (page: Page) => page.locator('[data-remote-backup-restore]');
  const message = (page: Page) => page.locator('[data-remote-backup-preview-status]');
  const activatePreview = async (page: Page) => { await button(page).focus(); await page.keyboard.press('Enter'); };
  const preparePreview = async (page: Page, index = 0) => {
    await activatePreview(page); await release(page, 'retrieve', index);
    await expect(button(page)).toHaveText('Open restore preview'); await expect(button(page)).toHaveAttribute('aria-disabled', 'false');
  };
  const readBackup = async (page: Page, update: Partial<ArchiveRemoteBackup> | null, index = 1) => {
    await page.evaluate(update => { window.__backupStatus.setRecoveryBackup(update); window.__backupStatus.refresh(); }, update);
    await storage(page, index); await release(page, 'health', index); await release(page, 'integrity', index);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
  };
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') });
    await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z')); await open(page);
  });

  test('expires a prepared preview without requests, navigation, node replacement or focus loss', async ({ page }) => {
    await preparePreview(page); const input = await button(page).elementHandle();
    await page.clock.fastForward(300_000); await expect(button(page)).toHaveText('Prepare a restore again');
    await expect(button(page)).toHaveAttribute('aria-disabled', 'false'); await expect(button(page)).toBeFocused();
    await expect(message(page)).toBeVisible(); await expect(message(page)).toContainText('preparation expired'); await expect(message(page)).toHaveAttribute('role', 'status');
    expect(await input!.evaluate(node => node.isConnected && node === document.querySelector('[data-remote-backup-restore]'))).toBe(true);
    expect(await count(page, 'retrieve')).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['retrieve']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('updates a stale Open action before allowing explicit preparation and opening the new preview', async ({ page }) => {
    await preparePreview(page); const now = await page.evaluate(() => Date.now()); await page.clock.setSystemTime(new Date(now + 300_001));
    await expect(button(page)).toHaveText('Open restore preview'); await activatePreview(page);
    await expect(button(page)).toHaveText('Prepare a restore again'); await expect(message(page)).toContainText('preparation expired');
    expect(await count(page, 'retrieve')).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['retrieve']);
    await activatePreview(page); await expect(message(page)).toContainText('Retrieving and verifying'); expect(await count(page, 'retrieve')).toBe(2);
    await release(page, 'retrieve', 1); await expect(button(page)).toHaveText('Open restore preview');
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['retrieve', 'retrieve']);
    await activatePreview(page); await expect(message(page)).toContainText('Nothing has been restored yet');
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['retrieve', 'retrieve', 'restore']);
  });

  test('does not extend a preparation deadline when history refreshes', async ({ page }) => {
    await preparePreview(page); await page.clock.fastForward(120_000);
    await page.evaluate(() => window.__backupStatus.refresh()); await storage(page, 1);
    await expect(button(page)).toHaveText('Open restore preview'); await page.clock.fastForward(180_000);
    await expect(button(page)).toHaveText('Prepare a restore again'); await expect(message(page)).toContainText('preparation expired');
    expect(await count(page, 'retrieve')).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['retrieve']);
  });

  test('disables expired preview preparation for a pruned copy while keeping its button focused', async ({ page }) => {
    await preparePreview(page); await readBackup(page, { state: 'pruned' });
    await expect(button(page)).toHaveText('Open restore preview'); await expect(button(page)).toHaveAttribute('aria-disabled', 'false');
    await page.clock.fastForward(300_000); await expect(button(page)).toHaveText('Prepare a restore again'); await expect(button(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(message(page)).toContainText('no longer verified'); await expect(button(page)).toBeFocused();
    await page.keyboard.press('Enter'); await button(page).dispatchEvent('click');
    expect(await count(page, 'retrieve')).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['retrieve']);
  });

  test('keeps copy-check progress and focus while preparation expires', async ({ page }) => {
    await preparePreview(page); const check = page.locator('[data-remote-backup-check]'); await check.focus(); await page.keyboard.press('Enter');
    await page.clock.fastForward(300_000); await expect(message(page)).toContainText('preparation expired');
    await expect(page.locator('[data-remote-backup-history]')).toContainText('Checking the stored copy…'); await expect(check).toBeFocused();
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['retrieve', 'check']);
    await release(page, 'check'); await expect(button(page)).toHaveAttribute('aria-disabled', 'false'); await expect(message(page)).toContainText('preparation expired');
  });

  for (const mode of ['removal', 'disposal'] as const) test(`cancels expiry on ${mode} and ignores activation of the old button`, async ({ page }) => {
    await preparePreview(page); const old = await button(page).elementHandle(), status = await message(page).elementHandle();
    if (mode === 'removal') await readBackup(page, null); else await page.evaluate(() => window.__backupStatus.dispose());
    const text = await status!.evaluate(node => node.textContent); await page.clock.fastForward(300_001); await old!.evaluate(node => { if (node instanceof HTMLButtonElement) node.click(); });
    expect(await status!.evaluate(node => node.textContent)).toBe(text); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['retrieve']);
  });

  test('ignores retrieval for a removed row even if a new row with the same identifier appears', async ({ page }) => {
    await activatePreview(page); const old = await button(page).elementHandle(); await readBackup(page, null); await readBackup(page, {}, 2);
    await release(page, 'retrieve'); await expect(button(page)).toHaveText('Prepare a restore'); await expect(message(page)).toBeHidden();
    await page.clock.fastForward(300_001); await expect(button(page)).toHaveText('Prepare a restore'); await old!.evaluate(node => { if (node instanceof HTMLButtonElement) node.click(); });
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['retrieve']);
  });

  test('keeps an explicit retry failure visible without automatic retrieval or preview opening', async ({ page }) => {
    await preparePreview(page); await page.clock.fastForward(300_000); await activatePreview(page); await release(page, 'retrieve', 1, 'error');
    await expect(message(page)).toContainText('No restore was started'); const text = await message(page).textContent();
    await page.clock.fastForward(300_001); await expect(message(page)).toHaveText(text!);
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['retrieve', 'retrieve']); await expect(page.locator('[data-remote-backups]')).not.toContainText('private provider');
  });
});

for (const width of [390]) test.describe(`Manual backup storage validation at ${width}px`, () => {
  const destination = (page: Page) => page.locator('[data-remote-backup-destination]');
  const keep = (page: Page) => page.locator('[data-remote-backup-keep]');
  const error = (page: Page, name: 'destination' | 'keep') => page.locator(`[data-remote-backup-${name}-error]`);
  const words = (page: Page) => page.locator('[data-recued-archive-backup-mnemonic]');
  const run = (page: Page) => page.locator('[data-recued-archive-backup-run]');
  const submit = async (page: Page) => { await run(page).focus(); await page.keyboard.press('Enter'); };
  const state = (page: Page) => page.evaluate(() => window.__backupStatus.manualState());
  const openManual = async (page: Page, remote = true) => {
    await page.goto('/backup-status-refresh-harness.html?manual-storage'); await page.waitForFunction(() => window.__backupStatus !== undefined);
  await openBackupDisclosure(page, 'tools');
    await storage(page); await release(page, 'health'); await release(page, 'integrity'); await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
    await openBackupDisclosure(page, 'manual-storage');
    if (remote) await destination(page).selectOption('Fixture backup storage');
  };
  const enterWords = async (page: Page) => {
    await page.locator('[data-recued-archive-backup-start]').click(); await page.evaluate(() => window.__backupStatus.fillManualWords());
  };
  const changeStorage = async (page: Page, id: string, index: number, beforeReply?: () => Promise<void>) => {
    await page.evaluate(id => { window.__backupStatus.setStorageDestinationId(id); window.__backupStatus.refresh(); }, id);
    if (beforeReply) await beforeReply();
    await storage(page, index); await release(page, 'health', index); await release(page, 'integrity', index);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
  };
  const expectNoExport = async (page: Page) => {
    expect(await state(page)).toMatchObject({ exports: [], statusCalls: 0, importCalls: 0, wordsPreserved: true });
    await expect(page.locator('[data-recued-archive-backup-result]')).toHaveCount(0); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
  };
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') });
    await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z'));
  });

  for (const invalid of ['', '0', '31', '1.5']) test(`identifies retention ${JSON.stringify(invalid)}, focuses it and clears only its corrected error`, async ({ page }) => {
    await openManual(page); await keep(page).fill(invalid); await expect(keep(page)).not.toHaveAttribute('aria-invalid'); await enterWords(page);
    const input = await words(page).elementHandle(); await submit(page);
    await expect(keep(page)).toBeFocused(); await expect(keep(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(keep(page)).toHaveAttribute('aria-describedby', (await error(page, 'keep').getAttribute('id'))!); await expect(error(page, 'keep')).toContainText('1 and 30');
    expect(await keep(page).evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })).toBe(true);
    expect(await input!.evaluate(node => node.isConnected && node === document.querySelector('[data-recued-archive-backup-mnemonic]'))).toBe(true);
    await expectNoExport(page); await keep(page).fill('3'); await expect(keep(page)).not.toHaveAttribute('aria-invalid'); await expect(error(page, 'keep')).toBeHidden();
    await expectNoExport(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('focuses a changed destination before retention, retains a stale selection, and exports only after an explicit correction', async ({ page }) => {
    await openManual(page); await keep(page).fill('1.5'); await changeStorage(page, 'c'.repeat(64), 1); await enterWords(page); await submit(page);
    await expect(destination(page)).toBeFocused(); await expect(destination(page)).toHaveAttribute('aria-invalid', 'true'); await expect(keep(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(destination(page)).toHaveAttribute('aria-describedby', (await error(page, 'destination').getAttribute('id'))!); await expectNoExport(page);
    await destination(page).selectOption('stale:Fixture backup storage'); await changeStorage(page, 'd'.repeat(64), 2, () => words(page).focus());
    await expect(destination(page)).toHaveValue('stale:Fixture backup storage'); await expect(words(page)).toBeFocused(); await expectNoExport(page);
    await destination(page).selectOption('Fixture backup storage'); await expect(destination(page)).not.toHaveAttribute('aria-invalid'); await expect(error(page, 'destination')).toBeHidden();
    await expect(keep(page)).toHaveAttribute('aria-invalid', 'true'); await submit(page); await expect(keep(page)).toBeFocused(); await expectNoExport(page);
    await keep(page).fill('3'); await expect(error(page, 'keep')).toBeHidden(); await expectNoExport(page); await submit(page);
    await expect(page.locator('[data-recued-archive-backup-view]')).toHaveAttribute('data-recued-archive-backup-view', 'export-done');
    expect(await state(page)).toMatchObject({ exports: [{ remote: { operation_id: expect.any(String), connection_name: 'Fixture backup storage', destination_id: 'd'.repeat(64), keep_last: 3 } }], statusCalls: 1, importCalls: 0, wordsPreserved: false });
    expect(Object.keys((await state(page)).exports[0]!)).toEqual(['remote']); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['manual-export']);
  });

  test('clears a restored destination error on refresh without stealing words focus or clearing a remaining retention error', async ({ page }) => {
    await openManual(page); await keep(page).fill('0'); await changeStorage(page, 'c'.repeat(64), 1); await enterWords(page); await submit(page);
    const select = await destination(page).elementHandle(), description = await error(page, 'destination').elementHandle();
    await changeStorage(page, 'a'.repeat(64), 2, () => words(page).focus());
    await expect(destination(page)).toHaveValue('Fixture backup storage'); await expect(destination(page)).not.toHaveAttribute('aria-invalid'); await expect(error(page, 'destination')).toBeHidden();
    await expect(words(page)).toBeFocused(); await expect(keep(page)).toHaveAttribute('aria-invalid', 'true'); await expectNoExport(page);
    expect(await select!.evaluate(node => node.isConnected && node === document.querySelector('[data-remote-backup-destination]'))).toBe(true);
    expect(await description!.evaluate(node => node.isConnected && node === document.querySelector('[data-remote-backup-destination-error]'))).toBe(true);
  });

  test('an explicit local backup clears both storage errors and ignores unused remote retention', async ({ page }) => {
    await openManual(page); await keep(page).fill('0'); await changeStorage(page, 'c'.repeat(64), 1); await enterWords(page); await submit(page); await expectNoExport(page);
    await destination(page).selectOption('');
    for (const control of [destination(page), keep(page)]) { await expect(control).not.toHaveAttribute('aria-invalid'); await expect(control).not.toHaveAttribute('aria-describedby'); }
    await expect(error(page, 'destination')).toBeHidden(); await expect(error(page, 'keep')).toBeHidden(); await expect(keep(page)).toHaveValue('0'); await expectNoExport(page);
    await submit(page); await expect(page.locator('[data-recued-archive-backup-view]')).toHaveAttribute('data-recued-archive-backup-view', 'export-done');
    expect(await state(page)).toEqual({ exports: [{ remote: null }], statusCalls: 1, importCalls: 0, wordsPreserved: false,
      downloadCalls: 0, downloadCancelled: 0, expiresAt: undefined });
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['manual-export']);
  });

  test('keeps recovery-key validation first and shows storage errors only after a valid key is supplied', async ({ page }) => {
    await openManual(page); await keep(page).fill('0'); await page.locator('[data-recued-archive-backup-start]').click(); await submit(page);
    await expect(words(page)).toBeFocused(); await expect(page.locator('[data-recued-archive-backup-result]')).toContainText('valid 24-word');
    await expect(keep(page)).not.toHaveAttribute('aria-invalid'); expect((await state(page)).exports).toEqual([]);
    await page.evaluate(() => window.__backupStatus.fillManualWords()); await submit(page); await expect(keep(page)).toBeFocused(); await expectNoExport(page);
  });
});

for (const width of [390]) test.describe(`Backup policy drafts at ${width}px`, () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') }); await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z'));
  });
  for (const kind of ['health', 'integrity'] as const) {
    const control = (page: Page, name: string) => page.locator(`[data-backup-${kind}-${name}]`);
    const original = kind === 'health' ? '36' : '03:00', submitted = kind === 'health' ? '48' : '05:00', newer = kind === 'health' ? '72' : '07:00';
    const clean = kind === 'health' ? 'No unsaved health limit changes.' : 'No unsaved S3 check changes.';
    const setLaterPolicy = (page: Page) => page.evaluate(kind => {
      if (kind === 'health') window.__backupStatus.setHealthPolicy({ alerts_enabled: false, backup_max_age_hours: 96, recovery_max_age_days: 14 });
      else window.__backupStatus.setIntegrityPolicy({ enabled: false, schedule: { cadence: 'daily', hour_utc: 4, minute_utc: 30, weekday_utc: 2 } });
    }, kind);
    const finishOtherReads = async (page: Page, index: number) => { await storage(page, index); await release(page, kind === 'health' ? 'integrity' : 'health', index); };

    test(`${kind} becomes clean when an edit is reverted and adopts the next saved policy`, async ({ page }) => {
      await open(page); const input = field(page, kind), node = await input.elementHandle();
      await input.fill(submitted); await expect(control(page, 'discard')).toBeEnabled(); await input.fill(original);
      await expect(control(page, 'draft-status')).toHaveText(clean); await expect(control(page, 'discard')).toBeDisabled();
      await setLaterPolicy(page); await activate(page); await finishOtherReads(page, 1); await input.focus(); await release(page, kind, 1);
      await expect(input).toHaveValue(kind === 'health' ? '96' : '04:30'); await expect(input).toBeFocused();
      await expect(control(page, 'enabled')).not.toBeChecked(); await expect(control(page, 'draft-status')).toHaveText(clean);
      expect(await node!.evaluate((node, kind) => node.isConnected && node === document.querySelector(kind === 'health' ? '[data-backup-health-hours]' : '[data-backup-integrity-time]'), kind)).toBe(true);
      await readOnly(page);
    });

    test(`${kind} Discard restores the latest confirmed policy and clears validation without requests or changing adjacent words`, async ({ page }) => {
      await open(page); const input = field(page, kind), node = await input.elementHandle();
      await input.fill(''); if (kind === 'health') await control(page, 'days').fill('366'); else { await control(page, 'cadence').selectOption('daily'); await control(page, 'day').selectOption('4'); }
      await save(page, kind).click(); await expect(input).toHaveAttribute('aria-invalid', 'true');
      await openBackupDisclosure(page, 'schedule');
      await page.locator('[data-unattended-words]').fill('synthetic adjacent unsubmitted words');
      await setLaterPolicy(page); await activate(page); await finishOtherReads(page, 1); await release(page, kind, 1);
      const calls = await page.evaluate(() => window.__backupStatus.calls), first = await time(page, kind).getAttribute('datetime');
      await control(page, 'discard').focus(); await page.keyboard.press('Enter');
      await expect(input).toHaveValue(kind === 'health' ? '96' : '04:30'); await expect(control(page, 'enabled')).not.toBeChecked(); await expect(control(page, 'enabled')).toBeFocused();
      if (kind === 'health') await expect(control(page, 'days')).toHaveValue('14'); else { await expect(control(page, 'cadence')).toHaveValue('daily'); await expect(control(page, 'day')).toHaveValue('2'); }
      await expect(input).not.toHaveAttribute('aria-invalid'); await expect(control(page, kind === 'health' ? 'hours-error' : 'time-error')).toBeHidden();
      await expect(control(page, 'draft-status')).toHaveText(clean); await expect(control(page, 'discard')).toBeDisabled();
      await expect(page.locator('[data-unattended-words]')).toHaveValue('synthetic adjacent unsubmitted words');
      await expect(time(page, kind)).toHaveAttribute('datetime', first!); expect(await page.evaluate(() => window.__backupStatus.calls)).toEqual(calls);
      expect(await node!.evaluate((node, kind) => node.isConnected && node === document.querySelector(kind === 'health' ? '[data-backup-health-hours]' : '[data-backup-integrity-time]'), kind)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await readOnly(page);
    });

    test(`${kind} does not claim newer edits after the form returns to its submitted values`, async ({ page }) => {
      await open(page); const input = field(page, kind); await input.fill(submitted); await save(page, kind).focus(); await page.keyboard.press('Enter');
      await input.fill(newer); await input.fill(submitted); await release(page, `save-${kind}`); await release(page, kind, 1);
      await expect(control(page, 'feedback')).toHaveText(kind === 'health' ? 'Health limits saved.' : 'S3 check schedule saved.');
      await expect(control(page, 'draft-status')).toHaveText(clean); await expect(control(page, 'discard')).toBeDisabled(); await expect(input).toBeFocused();
      await input.fill(newer); await expect(control(page, 'feedback')).toHaveText('');
      await control(page, 'discard').focus(); await page.keyboard.press('Enter'); await expect(input).toHaveValue(submitted);
      await expect(control(page, 'enabled')).toBeFocused(); await expect(control(page, 'draft-status')).toHaveText(clean);
      expect(await count(page, `save-${kind}`)).toBe(1); expect(await count(page, kind)).toBe(2); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
    });

    for (const uncertain of [false, true]) test(`${kind} preserves later edits equal to the old policy and allows Discard after settlement (uncertain: ${uncertain})`, async ({ page }) => {
      await open(page); const input = field(page, kind); await input.fill(submitted); await save(page, kind).click(); await input.fill(original);
      await expect(control(page, 'discard')).toBeDisabled(); await control(page, 'discard').dispatchEvent('click'); await expect(input).toHaveValue(original);
      await release(page, `save-${kind}`, 0, uncertain ? 'applied-error' : 'success'); await release(page, kind, 1);
      await expect(save(page, kind)).toBeEnabled(); await expect(input).toHaveValue(original); await expect(control(page, 'discard')).toBeEnabled();
      await expect(control(page, 'feedback')).toContainText(uncertain ? 'could not be confirmed' : 'newer edits'); const warning = await control(page, 'feedback').textContent();
      const calls = await page.evaluate(() => window.__backupStatus.calls); await control(page, 'discard').focus(); await page.keyboard.press('Enter');
      await expect(input).toHaveValue(submitted); await expect(control(page, 'draft-status')).toHaveText(clean); await expect(control(page, 'enabled')).toBeFocused();
      await expect(control(page, 'feedback')).toHaveText(uncertain ? warning! : ''); expect(await page.evaluate(() => window.__backupStatus.calls)).toEqual(calls);
      expect(await count(page, `save-${kind}`)).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
    });

    test(`${kind} Discard keeps reconciliation pending, retry blocked and the uncertain-save warning intact`, async ({ page }) => {
      await open(page); const input = field(page, kind); await input.fill(submitted); await save(page, kind).click(); await release(page, `save-${kind}`, 0, 'applied-error');
      await expect(control(page, 'feedback')).toContainText('could not be confirmed'); const warning = await control(page, 'feedback').textContent();
      await input.fill(newer); const calls = await page.evaluate(() => window.__backupStatus.calls); await control(page, 'discard').focus(); await page.keyboard.press('Enter');
      await expect(input).toHaveValue(original); await expect(save(page, kind)).toBeDisabled(); await expect(control(page, 'feedback')).toHaveText(warning!);
      await expect(refresh(page)).toHaveAttribute('aria-busy', 'true'); await expect(control(page, 'enabled')).toBeFocused();
      await expect(time(page, kind)).toHaveAttribute('datetime', '2023-11-14T22:13:20.000Z'); expect(await page.evaluate(() => window.__backupStatus.calls)).toEqual(calls);
      await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, kind, 1);
      await expect(input).toHaveValue(submitted); await expect(save(page, kind)).toBeEnabled(); await expect(control(page, 'feedback')).toHaveText(warning!);
      await input.fill(''); await save(page, kind).click(); await expect(input).toHaveAttribute('aria-invalid', 'true'); await expect(control(page, 'feedback')).toHaveText(warning!);
      await control(page, 'discard').focus(); await page.keyboard.press('Enter'); await expect(input).toHaveValue(submitted);
      await expect(input).not.toHaveAttribute('aria-invalid'); await expect(control(page, 'feedback')).toHaveText(warning!); await expect(control(page, 'draft-status')).toHaveText(clean);
      expect(await count(page, `save-${kind}`)).toBe(1); expect(await count(page, kind)).toBe(2); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
    });

    for (const outcome of ['error', 'unavailable'] as const) test(`${kind} Discard uses the last usable policy after a ${outcome} read and stays read-only through recovery`, async ({ page }) => {
      await open(page); const input = field(page, kind); await input.fill(submitted); await setLaterPolicy(page);
      await activate(page); await finishOtherReads(page, 1); await release(page, kind, 1, outcome);
      await expect(freshness(page, kind)).toContainText('Latest status refresh failed.'); const calls = await page.evaluate(() => window.__backupStatus.calls);
      await control(page, 'discard').focus(); await page.keyboard.press('Enter'); await expect(input).toHaveValue(original); await expect(save(page, kind)).toBeDisabled();
      await expect(freshness(page, kind)).toContainText('Latest status refresh failed.'); expect(await page.evaluate(() => window.__backupStatus.calls)).toEqual(calls);
      await activate(page); await finishOtherReads(page, 2); await release(page, kind, 2);
      await expect(input).toHaveValue(kind === 'health' ? '96' : '04:30'); await expect(save(page, kind)).toBeEnabled(); await expect(control(page, 'draft-status')).toHaveText(clean); await readOnly(page);
    });

    test(`${kind} moves focus from Discard when a refreshed policy makes the draft clean`, async ({ page }) => {
      await open(page); const input = field(page, kind); await input.fill(submitted);
      await page.evaluate(kind => {
        if (kind === 'health') window.__backupStatus.setHealthPolicy({ alerts_enabled: true, backup_max_age_hours: 48, recovery_max_age_days: 30 });
        else window.__backupStatus.setIntegrityPolicy({ enabled: true, schedule: { cadence: 'weekly', hour_utc: 5, minute_utc: 0, weekday_utc: 0 } });
      }, kind);
      await activate(page); await finishOtherReads(page, 1); await control(page, 'discard').focus(); await release(page, kind, 1);
      await expect(control(page, 'discard')).toBeDisabled(); await expect(control(page, 'enabled')).toBeFocused(); await expect(control(page, 'draft-status')).toHaveText(clean); await readOnly(page);
    });
  }
});

for (const width of [390]) test.describe(`Backup policy save recovery at ${width}px`, () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: new Date('2023-11-14T22:13:20.000Z') }); await page.clock.pauseAt(new Date('2023-11-14T22:13:21.000Z'));
  });

  for (const kind of ['health', 'integrity'] as const) {
    for (const outcome of ['error', 'applied-error', 'mismatch', 'unavailable', 'malformed'] as const) test(`${kind} blocks retry after a ${outcome} save reply until a fresh read and then saves only the retained draft`, async ({ page }) => {
      await open(page); const input = field(page, kind), node = await input.elementHandle();
      const feedback = page.locator(`[data-backup-${kind}-feedback]`), submitted = kind === 'health' ? '48' : '05:00';
      const newer = outcome === 'unavailable' || outcome === 'malformed' ? submitted : kind === 'health' ? '72' : '07:00';
      await input.fill(submitted); await save(page, kind).focus(); await page.keyboard.press('Enter');
      if (newer !== submitted) await input.fill(newer); await release(page, `save-${kind}`, 0, outcome);
      await expect(feedback).toContainText('could not be confirmed'); const warning = await feedback.textContent();
      await expect.poll(() => count(page, kind)).toBe(2); await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
      await expect(time(page, kind)).toHaveAttribute('datetime', '2023-11-14T22:13:20.000Z');
      await blockedPolicyRetry(page, kind); await expect(feedback).toHaveText(warning!); await input.focus();
      await page.evaluate(() => window.__backupStatus.advance(2_000)); await release(page, kind, 1);
      await expect(save(page, kind)).toBeEnabled(); await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
      await expect(time(page, kind)).toHaveAttribute('datetime', '2023-11-14T22:13:22.000Z');
      await expect(input).toHaveValue(newer); await expect(input).toBeFocused(); await expect(feedback).toHaveText(warning!);
      expect(await node!.evaluate((node, kind) => node.isConnected && node === document.querySelector(kind === 'health' ? '[data-backup-health-hours]' : '[data-backup-integrity-time]'), kind)).toBe(true);
      await save(page, kind).focus(); await page.keyboard.press('Enter'); await expect.poll(() => count(page, `save-${kind}`)).toBe(2);
      const retried = await page.evaluate(kind => window.__backupStatus.calls.filter(call => call.kind === `save-${kind}`).at(-1)!.policy, kind);
      expect(retried).toEqual(kind === 'health' ? { alerts_enabled: true, backup_max_age_hours: Number(newer), recovery_max_age_days: 30 }
        : { enabled: true, schedule: { cadence: 'weekly', hour_utc: Number(newer.split(':')[0]), minute_utc: 0, weekday_utc: 0 } });
      await release(page, `save-${kind}`, 1); await release(page, kind, 2);
      await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); await expect(feedback).toContainText('saved.');
      expect(await count(page, `save-${kind === 'health' ? 'integrity' : 'health'}`)).toBe(0);
      expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });

    for (const outcome of ['error', 'unavailable', 'malformed'] as const) test(`${kind} stays blocked through a ${outcome} reconciliation read and recovers without replay`, async ({ page }) => {
      await open(page); const input = field(page, kind), feedback = page.locator(`[data-backup-${kind}-feedback]`);
      await input.fill(kind === 'health' ? '48' : '05:00'); await save(page, kind).click(); await release(page, `save-${kind}`, 0, 'applied-error');
      await expect(feedback).toContainText('could not be confirmed'); const warning = await feedback.textContent();
      await input.fill(kind === 'health' ? '72' : '07:00');
      await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, kind, 1, outcome);
      await expect(freshness(page, kind)).toContainText('Latest status refresh failed.'); await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
      await expect(time(page, kind)).toHaveAttribute('datetime', '2023-11-14T22:13:20.000Z');
      await blockedPolicyRetry(page, kind); await expect(feedback).toHaveText(warning!);
      await activate(page); await storage(page, 1); await release(page, kind === 'health' ? 'integrity' : 'health', 1);
      await blockedPolicyRetry(page, kind); await input.focus(); await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
      await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, kind, 2);
      await expect(save(page, kind)).toBeEnabled(); await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
      await expect(time(page, kind)).toHaveAttribute('datetime', '2023-11-14T22:13:22.000Z'); await expect(feedback).toHaveText(warning!);
      await expect(input).toHaveValue(kind === 'health' ? '72' : '07:00'); await expect(input).toBeFocused();
      expect(await count(page, `save-${kind}`)).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
      await expect(page.locator('[data-remote-backups]')).not.toContainText('private provider');
    });
  }
});

for (const width of [390]) test.describe(`Backup schedule status refresh at ${width}px`, () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: 900 }); });

  test('keeps shared Refresh busy for a schedule read and preserves drafts, focus and the prior read time', async ({ page }) => {
    await openSchedule(page); const input = schedule(page, 'time'), node = await input.elementHandle();
    const initialReads = await count(page, 'unattended');
    await input.fill('03:30'); await schedule(page, 'words').fill('synthetic unsubmitted refresh words');
    await activate(page); await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'true'); await expect(refresh(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(refresh(page)).toHaveText('Refreshing backup status…'); await expect(refresh(page)).not.toHaveAttribute('disabled');
    await expect(schedule(page, 'refresh-status')).toContainText('Refreshing schedule status…');
    await expect(schedule(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:20.000Z');
    await page.keyboard.press('Enter'); await expect(refresh(page)).toBeFocused();
    expect(await count(page, 'unattended')).toBe(initialReads + 1); expect(await count(page, 'history')).toBe(2);
    await input.focus(); await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'unattended');
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); await expect(input).toBeFocused();
    await expect(schedule(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:21.000Z');
    await expect(input).toHaveValue('03:30'); await expect(schedule(page, 'words')).toHaveValue('synthetic unsubmitted refresh words');
    expect(await node!.evaluate(node => node.isConnected && node === document.querySelector('[data-unattended-time]'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await readOnly(page);
  });

  for (const outcome of ['error', 'malformed'] as const) test(`retains the last successful read after ${outcome}, including Discard, and recovers without writing`, async ({ page }) => {
    await openSchedule(page); await schedule(page, 'time').fill('03:30'); await schedule(page, 'words').fill('synthetic discarded refresh words');
    await activate(page); await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'unattended', 0, outcome);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); await expect(schedule(page, 'save')).toBeDisabled();
    await expect(schedule(page, 'refresh-status')).toContainText('Latest schedule status refresh failed.');
    await expect(schedule(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:20.000Z');
    await schedule(page, 'discard').focus(); await page.keyboard.press('Enter');
    await expect(schedule(page, 'time')).toHaveValue('02:00'); await expect(schedule(page, 'words')).toHaveValue('');
    await expect(schedule(page, 'refresh-status')).toContainText('Latest schedule status refresh failed.');
    await expect(schedule(page, 'save')).toBeDisabled(); await expect(schedule(page, 'enabled')).toBeFocused();
    await activate(page); await schedule(page, 'time').focus(); await storage(page, 2); await release(page, 'health', 2); await release(page, 'integrity', 2);
    await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'unattended', 1);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); await expect(schedule(page, 'save')).toBeEnabled();
    await expect(schedule(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:22.000Z');
    await expect(schedule(page, 'refresh-status')).not.toContainText('failed'); await expect(schedule(page, 'time')).toBeFocused();
    await expect(page.locator('[data-remote-backups]')).not.toContainText('private provider'); await readOnly(page);
  });

  for (const oldFirst of [true, false]) test(`waits for a fresh read after a save rather than accepting the pre-save reply (old first: ${oldFirst})`, async ({ page }) => {
    await openSchedule(page); const initialReads = await count(page, 'unattended');
    await activate(page); await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await schedule(page, 'time').fill('03:30'); await schedule(page, 'words').fill('synthetic submitted refresh words'); await schedule(page, 'save').click();
    await schedule(page, 'time').fill('07:15');
    await expect(schedule(page, 'refresh-status')).toContainText('Waiting to refresh schedule status after the save.');
    if (oldFirst) {
      await release(page, 'unattended'); await expect(schedule(page, 'refresh-status')).toContainText('Waiting to refresh schedule status after the save.');
      expect(await count(page, 'unattended')).toBe(initialReads + 1);
    }
    await page.evaluate(() => window.__backupStatus.advance(2_000)); await release(page, 'save-unattended', 0, oldFirst ? 'success' : 'applied-error');
    if (!oldFirst) { expect(await count(page, 'unattended')).toBe(initialReads + 1); await release(page, 'unattended', 0, 'error'); }
    await expect.poll(() => count(page, 'unattended')).toBe(initialReads + 2);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'true'); await expect(schedule(page, 'refresh-status')).toContainText('Refreshing schedule status…');
    await expect(schedule(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:20.000Z');
    await expect(schedule(page, 'feedback')).toContainText(oldFirst ? 'newer edits' : 'could not be confirmed');
    await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'unattended', 1);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); await expect(schedule(page, 'save')).toBeEnabled();
    await expect(schedule(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:23.000Z');
    await expect(schedule(page, 'time')).toHaveValue('07:15'); await expect(schedule(page, 'time')).toBeFocused(); await expect(schedule(page, 'words')).toHaveValue('');
    await expect(schedule(page, 'feedback')).toContainText(oldFirst ? 'newer edits' : 'could not be confirmed');
    expect(await count(page, 'save-unattended')).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify(window.__backupStatus.calls))).not.toContain('synthetic submitted refresh words');
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join())).not.toContain('synthetic submitted refresh words');
  });

  test('keeps the pending read and uncertain-save warning visible when discarding during reconciliation', async ({ page }) => {
    await openSchedule(page); await schedule(page, 'time').fill('03:30'); await schedule(page, 'save').click();
    await release(page, 'save-unattended', 0, 'applied-error'); const warning = await schedule(page, 'feedback').textContent();
    await expect(schedule(page, 'feedback')).toContainText('could not be confirmed'); await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await schedule(page, 'words').fill('synthetic newer reconciliation words'); await schedule(page, 'discard').focus(); await page.keyboard.press('Enter');
    await expect(schedule(page, 'time')).toHaveValue('02:00'); await expect(schedule(page, 'words')).toHaveValue('');
    await expect(schedule(page, 'save')).toBeDisabled(); await expect(schedule(page, 'enabled')).toBeFocused();
    await expect(schedule(page, 'refresh-status')).toContainText('Refreshing schedule status…');
    await expect(schedule(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:20.000Z');
    await expect(schedule(page, 'feedback')).toHaveText(warning!); await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'unattended');
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); await expect(schedule(page, 'save')).toBeEnabled();
    await expect(schedule(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:21.000Z');
    await expect(schedule(page, 'time')).toHaveValue('03:30'); await expect(schedule(page, 'feedback')).toHaveText(warning!);
    expect(await count(page, 'save-unattended')).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
  });

  test('ignores a late schedule read after disposal and clears unsubmitted words', async ({ page }) => {
    await openSchedule(page); await schedule(page, 'words').fill('synthetic disposed refresh words');
    await page.evaluate(() => window.__backupStatus.refresh()); const prior = await schedule(page, 'refresh-status').textContent();
    await page.evaluate(() => { window.__backupStatus.dispose(); window.__backupStatus.advance(5_000); });
    await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1); await release(page, 'unattended');
    await expect(schedule(page, 'refresh-status')).toHaveText(prior!); await expect(schedule(page, 'words')).toHaveValue('');
    await expect(schedule(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:20.000Z');
    await expect(schedule(page, 'save')).toBeDisabled(); await readOnly(page);
  });
});

for (const width of [390]) test.describe(`Backup schedule drafts at ${width}px`, () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: 900 }); });

  test('reverting edits restores clean state and allows a later saved schedule to appear', async ({ page }) => {
    await openSchedule(page); const input = schedule(page, 'time'), node = await input.elementHandle();
    await input.fill('03:30'); await expect(schedule(page, 'draft-status')).toHaveText('Unsaved schedule changes.');
    await input.fill('02:00'); await expect(schedule(page, 'draft-status')).toHaveText('No unsaved schedule changes.');
    await expect(schedule(page, 'discard')).toBeDisabled();
    await page.evaluate(() => { window.__backupStatus.setScheduleTime(4); window.__backupStatus.refresh(); });
    await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1); await release(page, 'unattended');
    await expect(input).toHaveValue('04:00'); await expect(input).toBeFocused();
    expect(await node!.evaluate(node => node.isConnected && node === document.querySelector('[data-unattended-time]'))).toBe(true);
    await expect(schedule(page, 'discard')).toBeDisabled(); await readOnly(page);
  });

  test('discard restores the latest confirmed settings and clears words without a request', async ({ page }) => {
    await openSchedule(page); const input = schedule(page, 'time'), node = await input.elementHandle();
    await input.fill('03:30'); await schedule(page, 'words').fill('synthetic discarded schedule words');
    await page.evaluate(() => { window.__backupStatus.setScheduleTime(4); window.__backupStatus.refresh(); });
    await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1); await release(page, 'unattended');
    await expect(input).toHaveValue('03:30'); const reads = await count(page, 'unattended');
    await schedule(page, 'discard').focus(); await page.keyboard.press('Enter');
    await expect(input).toHaveValue('04:00'); await expect(schedule(page, 'words')).toHaveValue(''); await expect(schedule(page, 'enabled')).toBeFocused();
    await expect(schedule(page, 'discard')).toBeDisabled(); await expect(schedule(page, 'draft-status')).toHaveText('No unsaved schedule changes.');
    expect(await node!.evaluate(node => node.isConnected && node === document.querySelector('[data-unattended-time]'))).toBe(true);
    expect(await count(page, 'unattended')).toBe(reads); await readOnly(page);
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join())).not.toContain('synthetic discarded schedule words');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('first-setup discard restores defaults and clears local validation', async ({ page }) => {
    await openSchedule(page, true); await schedule(page, 'time').fill(''); await schedule(page, 'keep').fill('31');
    await schedule(page, 'words').fill('synthetic first-setup draft'); await schedule(page, 'save').click();
    await expect(schedule(page, 'time')).toHaveAttribute('aria-invalid', 'true');
    await schedule(page, 'discard').focus(); await page.keyboard.press('Enter');
    await expect(schedule(page, 'time')).toHaveValue('02:00'); await expect(schedule(page, 'keep')).toHaveValue('5');
    await expect(schedule(page, 'destination')).toHaveValue(''); await expect(schedule(page, 'words')).toHaveValue('');
    await expect(schedule(page, 'enabled')).toBeChecked(); await expect(schedule(page, 'enabled')).toBeFocused();
    for (const field of ['destination', 'time', 'keep', 'words']) {
      await expect(schedule(page, field)).not.toHaveAttribute('aria-invalid'); await expect(schedule(page, `${field}-error`)).toBeHidden();
    }
    await expect(schedule(page, 'draft-status')).toHaveText('No unsaved schedule changes.'); await readOnly(page);
  });

  test('discard preserves an uncertain-save warning and keeps retry blocked until reconciliation', async ({ page }) => {
    await openSchedule(page); await schedule(page, 'time').fill('03:30'); await schedule(page, 'words').fill('synthetic submitted schedule words');
    await schedule(page, 'save').click(); await release(page, 'save-unattended', 0, 'applied-error');
    await expect(schedule(page, 'feedback')).toContainText('could not be confirmed'); await expect(schedule(page, 'save')).toBeDisabled();
    const warning = await schedule(page, 'feedback').textContent(); await schedule(page, 'words').fill('synthetic newer discarded words');
    await schedule(page, 'discard').focus(); await page.keyboard.press('Enter');
    await expect(schedule(page, 'words')).toHaveValue(''); await expect(schedule(page, 'time')).toHaveValue('02:00');
    await expect(schedule(page, 'enabled')).toBeFocused(); await expect(schedule(page, 'save')).toBeDisabled();
    await expect(schedule(page, 'feedback')).toHaveText(warning!); await release(page, 'unattended');
    await expect(schedule(page, 'save')).toBeEnabled(); await expect(schedule(page, 'time')).toHaveValue('03:30');
    await expect(schedule(page, 'feedback')).toHaveText(warning!); await expect(schedule(page, 'discard')).toBeDisabled();
    expect(await count(page, 'save-unattended')).toBe(1);
  });

  for (const uncertain of [false, true]) test(`retains later edits during a save and discards only after it settles (uncertain: ${uncertain})`, async ({ page }) => {
    const newerWords = uncertain ? '' : 'synthetic newer schedule words';
    await openSchedule(page); await schedule(page, 'time').fill('03:30'); await schedule(page, 'save').click();
    await schedule(page, 'time').fill('02:00'); await schedule(page, 'words').fill(newerWords);
    await expect(schedule(page, 'discard')).toBeDisabled(); await schedule(page, 'discard').evaluate((button: HTMLButtonElement) => button.click());
    await expect(schedule(page, 'words')).toHaveValue(newerWords);
    await release(page, 'save-unattended', 0, uncertain ? 'applied-error' : 'success'); await release(page, 'unattended');
    await expect(schedule(page, 'save')).toBeEnabled(); await expect(schedule(page, 'time')).toHaveValue('02:00');
    await expect(schedule(page, 'words')).toHaveValue(newerWords); await expect(schedule(page, 'discard')).toBeEnabled();
    await schedule(page, 'discard').focus(); await page.keyboard.press('Enter');
    await expect(schedule(page, 'time')).toHaveValue('03:30'); await expect(schedule(page, 'words')).toHaveValue(''); await expect(schedule(page, 'enabled')).toBeFocused();
    await expect(schedule(page, 'draft-status')).toHaveText('No unsaved schedule changes.');
    if (uncertain) await expect(schedule(page, 'feedback')).toContainText('could not be confirmed'); else await expect(schedule(page, 'feedback')).toHaveText('');
    expect(await count(page, 'save-unattended')).toBe(1);
  });

  test('edits returned to the submitted schedule do not leave a false newer-edits message', async ({ page }) => {
    await openSchedule(page); await schedule(page, 'time').fill('03:30'); await schedule(page, 'save').click();
    await schedule(page, 'time').fill('07:15'); await schedule(page, 'time').fill('03:30');
    await release(page, 'save-unattended'); await release(page, 'unattended'); await expect(schedule(page, 'save')).toBeEnabled();
    await expect(schedule(page, 'draft-status')).toHaveText('No unsaved schedule changes.'); await expect(schedule(page, 'discard')).toBeDisabled();
    await expect(schedule(page, 'feedback')).not.toContainText('newer edits'); expect(await count(page, 'save-unattended')).toBe(1);
  });
});

for (const width of [390]) test.describe(`Backup schedule save confirmation at ${width}px`, () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: 900 }); });

  for (const outcome of ['mismatch', 'unconfigured', 'malformed'] as const) test(`preserves the draft and waits for status after a ${outcome} reply`, async ({ page }) => {
    await openSchedule(page); const input = schedule(page, 'time'), node = await input.elementHandle();
    await input.fill('03:30'); await schedule(page, 'words').fill('synthetic submitted schedule words');
    await schedule(page, 'save').focus(); await page.keyboard.press('Enter'); await expect(schedule(page, 'words')).toHaveValue('');
    await release(page, 'save-unattended', 0, outcome); await expect(schedule(page, 'feedback')).toContainText('could not be confirmed');
    await expect(schedule(page, 'save')).toBeDisabled(); await expect(input).toHaveValue('03:30');
    await input.fill('07:15'); await schedule(page, 'save').evaluate((button: HTMLButtonElement) => button.click());
    expect(await count(page, 'save-unattended')).toBe(1); await release(page, 'unattended');
    await expect(schedule(page, 'save')).toBeEnabled(); await expect(input).toBeFocused(); await expect(input).toHaveValue('07:15');
    await expect(schedule(page, 'feedback')).toContainText('could not be confirmed');
    expect(await node!.evaluate(node => node.isConnected && node === document.querySelector('[data-unattended-time]'))).toBe(true);
    await expect(schedule(page, 'words')).toHaveValue('');
    expect(await page.evaluate(() => JSON.stringify(window.__backupStatus.calls))).not.toContain('synthetic submitted schedule words');
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join())).not.toContain('synthetic submitted schedule words');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  for (const firstSetup of [true, false]) test(`reconciles a lost reply without confirming a key change or replaying words (first setup: ${firstSetup})`, async ({ page }) => {
    await openSchedule(page, firstSetup); await schedule(page, 'time').fill('03:30');
    await schedule(page, 'words').fill('synthetic one-time schedule words'); await schedule(page, 'save').click();
    await expect(schedule(page, 'words')).toHaveValue(''); await release(page, 'save-unattended', 0, 'applied-error');
    await expect(schedule(page, 'feedback')).toContainText('could not be confirmed'); await expect(schedule(page, 'save')).toBeDisabled();
    await release(page, 'unattended'); await expect(schedule(page, 'save')).toBeEnabled();
    await expect(schedule(page, 'status')).toContainText('Enabled'); await expect(schedule(page, 'time')).toHaveValue('03:30');
    await expect(schedule(page, 'feedback')).toContainText('could not be confirmed'); await expect(schedule(page, 'words')).toHaveValue('');
    expect(await count(page, 'save-unattended')).toBe(1);
    await schedule(page, 'keep').fill('8'); await schedule(page, 'save').click(); await release(page, 'save-unattended', 1);
    await expect(schedule(page, 'feedback')).toContainText('Backup schedule saved.'); await release(page, 'unattended', 1);
    await expect(schedule(page, 'words')).toHaveValue(''); expect(await count(page, 'save-unattended')).toBe(2);
    expect(await page.evaluate(() => JSON.stringify(window.__backupStatus.calls))).not.toContain('synthetic one-time schedule words');
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
  });

  for (const outcome of ['error', 'malformed'] as const) test(`keeps retry blocked after a ${outcome} status read and preserves newer words`, async ({ page }) => {
    await openSchedule(page); await schedule(page, 'time').fill('03:30'); await schedule(page, 'save').click();
    await release(page, 'save-unattended', 0, 'error'); await expect(schedule(page, 'feedback')).toContainText('could not be confirmed');
    await schedule(page, 'words').fill('synthetic newer unsubmitted words'); await release(page, 'unattended', 0, outcome);
    await expect(schedule(page, 'status')).toContainText('could not be checked'); await expect(schedule(page, 'save')).toBeDisabled();
    await schedule(page, 'save').evaluate((button: HTMLButtonElement) => button.click()); expect(await count(page, 'save-unattended')).toBe(1);
    await page.evaluate(() => window.__backupStatus.refresh()); await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await release(page, 'unattended', 1); await expect(schedule(page, 'save')).toBeEnabled();
    await expect(schedule(page, 'words')).toBeFocused(); await expect(schedule(page, 'words')).toHaveValue('synthetic newer unsubmitted words');
    await expect(schedule(page, 'time')).toHaveValue('03:30'); await expect(schedule(page, 'feedback')).toContainText('could not be confirmed');
    await page.evaluate(() => window.__backupStatus.dispose()); await expect(schedule(page, 'words')).toHaveValue('');
  });

  for (const oldFirst of [true, false]) test(`reconciles a pre-save read without waiting for a poll (old first: ${oldFirst})`, async ({ page }) => {
    await openSchedule(page); const initialReads = await count(page, 'unattended');
    await page.evaluate(() => window.__backupStatus.refresh()); await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await expect.poll(() => count(page, 'unattended')).toBe(initialReads + 1);
    await schedule(page, 'time').fill('03:30'); await schedule(page, 'words').fill('synthetic race schedule words'); await schedule(page, 'save').click();
    await schedule(page, 'time').fill('07:15');
    if (oldFirst) await release(page, 'unattended');
    await release(page, 'save-unattended', 0, oldFirst ? 'success' : 'applied-error');
    await expect(schedule(page, 'feedback')).toContainText(oldFirst ? 'newer edits' : 'could not be confirmed');
    if (!oldFirst) { expect(await count(page, 'unattended')).toBe(initialReads + 1); await release(page, 'unattended', 0, 'error'); }
    await expect.poll(() => count(page, 'unattended')).toBe(initialReads + 2);
    if (!oldFirst) await expect(schedule(page, 'save')).toBeDisabled();
    await release(page, 'unattended', 1); await expect(schedule(page, 'save')).toBeEnabled();
    await expect(schedule(page, 'time')).toBeFocused(); await expect(schedule(page, 'time')).toHaveValue('07:15'); await expect(schedule(page, 'words')).toHaveValue('');
    await expect(schedule(page, 'feedback')).toContainText(oldFirst ? 'newer edits' : 'could not be confirmed');
    expect(await count(page, 'save-unattended')).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
  });
});

for (const width of [390]) test.describe(`Monitor status refresh at ${width}px`, () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: 900 }); });

  test('tracks pending monitor reads, preserves drafts and keeps read time separate from ping time', async ({ page }) => {
    await openMonitor(page, false);
    await expect(refresh(page)).toHaveText('Refreshing backup status…'); await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await expect(monitor(page, 'refresh-status')).toContainText('No successful monitor status refresh yet.');
    await expect(monitor(page, 'last-refreshed')).toHaveCount(0); await activate(page);
    expect(await count(page, 'history')).toBe(1); expect(await count(page, 'watchdog')).toBe(1);
    const url = monitor(page, 'url'); await url.fill('https://draft.example/private-monitor-refresh'); const node = await url.elementHandle();
    await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'watchdog');
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); await expect(url).toBeFocused();
    const ping = await monitor(page, 'receipt').textContent();
    await expect(monitor(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:21.000Z');
    await page.evaluate(() => window.__backupStatus.refresh()); await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'true'); await expect(monitor(page, 'refresh-status')).toContainText('Refreshing monitor status…');
    await refresh(page).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    expect(await count(page, 'history')).toBe(2); expect(await count(page, 'watchdog')).toBe(2);
    await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'watchdog', 1);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); await expect(url).toBeFocused();
    await expect(monitor(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:22.000Z');
    await expect(monitor(page, 'receipt')).toHaveText(ping!); await expect(url).toHaveValue('https://draft.example/private-monitor-refresh');
    expect(await node!.evaluate(node => node.isConnected && node === document.querySelector('[data-backup-watchdog-url]'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await readOnly(page);
  });

  for (const outcome of ['error', 'unavailable'] as const) test(`retains the last good read time after ${outcome} and recovers without writing`, async ({ page }) => {
    await openMonitor(page); const first = await monitor(page, 'last-refreshed').getAttribute('datetime'), url = monitor(page, 'url');
    await url.fill('https://draft.example/private-monitor-retry'); await activate(page); await url.focus();
    await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'watchdog', 1, outcome);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); await expect(monitor(page, 'refresh-status')).toContainText('Latest monitor status refresh failed.');
    await expect(monitor(page, 'last-refreshed')).toHaveAttribute('datetime', first!); await expect(monitor(page, 'save')).toBeDisabled();
    await expect(monitor(page, 'receipt')).toHaveText(''); await expect(url).toBeFocused();
    await activate(page); await url.focus(); await storage(page, 2); await release(page, 'health', 2); await release(page, 'integrity', 2);
    await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'watchdog', 2);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); await expect(monitor(page, 'refresh-status')).not.toContainText('failed');
    await expect(monitor(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:22.000Z');
    await expect(url).toBeFocused(); await expect(url).toHaveValue('https://draft.example/private-monitor-retry');
    await expect(page.locator('[data-remote-backups]')).not.toContainText('private provider'); await readOnly(page);
  });

  for (const oldFirst of [true, false]) test(`fences a pre-save read and preserves newer drafts and write feedback (old first: ${oldFirst})`, async ({ page }) => {
    await openMonitor(page); const first = await monitor(page, 'last-refreshed').getAttribute('datetime'), url = monitor(page, 'url');
    await activate(page); await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await url.fill('https://draft.example/private-monitor-submitted'); await monitor(page, 'save').click();
    await expect.poll(() => count(page, 'save-watchdog')).toBe(1); await url.fill('https://draft.example/private-monitor-newer');
    await expect(monitor(page, 'refresh-status')).toContainText('Waiting to refresh monitor status after the current action.');
    if (oldFirst) { await release(page, 'watchdog', 1); expect(await count(page, 'watchdog')).toBe(2); }
    await page.evaluate(() => window.__backupStatus.advance(2_000)); await release(page, 'save-watchdog', 0, oldFirst ? 'success' : 'error');
    if (!oldFirst) { expect(await count(page, 'watchdog')).toBe(2); await release(page, 'watchdog', 1, 'error'); }
    await expect.poll(() => count(page, 'watchdog')).toBe(3); await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await expect(monitor(page, 'refresh-status')).toContainText('Refreshing monitor status…');
    await expect(monitor(page, 'last-refreshed')).toHaveAttribute('datetime', first!);
    await expect(monitor(page, 'feedback')).toContainText(oldFirst ? 'newer edits' : 'could not be confirmed');
    await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'watchdog', 2);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false'); await expect(monitor(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:23.000Z');
    await expect(url).toBeFocused(); await expect(url).toHaveValue('https://draft.example/private-monitor-newer');
    await expect(monitor(page, 'feedback')).toContainText(oldFirst ? 'newer edits' : 'could not be confirmed');
    expect(await count(page, 'save-watchdog')).toBe(1); expect(await page.evaluate(() => JSON.stringify(window.__backupStatus.calls))).not.toContain('private-monitor');
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
  });

  test('ignores a late monitor read after disposal and clears the URL draft', async ({ page }) => {
    await openMonitor(page); await monitor(page, 'url').fill('https://draft.example/private-monitor-disposed');
    await page.evaluate(() => window.__backupStatus.refresh()); const prior = await monitor(page, 'refresh-status').textContent();
    await page.evaluate(() => { window.__backupStatus.dispose(); window.__backupStatus.advance(5_000); });
    await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1); await release(page, 'watchdog', 1);
    await expect(monitor(page, 'refresh-status')).toHaveText(prior!); await expect(monitor(page, 'url')).toHaveValue('');
    await expect(monitor(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:20.000Z');
    await expect(monitor(page, 'save')).toBeDisabled(); await readOnly(page);
  });
});

for (const width of [390]) test.describe(`Recovery backup reselection at ${width}px`, () => {
  const words = (page: Page) => recoveryNode(page, 'words');
  const start = (page: Page) => recoveryNode(page, 'start');
  const feedback = (page: Page) => recoveryNode(page, 'feedback');
  const choose = async (page: Page) => { await page.locator('[data-remote-backup-drill]').focus(); await page.keyboard.press('Enter'); };
  const submit = async (page: Page) => { await start(page).focus(); await page.keyboard.press('Enter'); };
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: 900 }); await openRecovery(page); });

  test('keeps the same draft and form node when selecting the same backup with mouse and keyboard', async ({ page }) => {
    const input = await words(page).elementHandle(), selected = await recoveryNode(page, 'selected').textContent();
    const first = await recoveryNode(page, 'last-refreshed').getAttribute('datetime'), calls = await page.evaluate(() => window.__backupStatus.calls.length);
    await words(page).fill('  synthetic unsent words  '); const message = await feedback(page).textContent();
    await openBackupCopyDetails(page.locator('[data-remote-backup-id]').first());
    await page.locator('[data-remote-backup-drill]').click(); await choose(page);
    await expect(words(page)).toHaveValue('  synthetic unsent words  '); await expect(words(page)).toBeFocused();
    await expect(recoveryNode(page, 'selected')).toHaveText(selected!); await expect(feedback(page)).toHaveText(message!);
    expect(await input!.evaluate(node => node.isConnected && node === document.querySelector('[data-drill-words]'))).toBe(true);
    await expect(recoveryNode(page, 'last-refreshed')).toHaveAttribute('datetime', first!);
    expect(await page.evaluate(() => window.__backupStatus.calls.length)).toBe(calls); await readOnly(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('keeps a draft across refreshed display metadata while updating the selection label', async ({ page }) => {
    await words(page).fill('synthetic unsent draft'); const message = await feedback(page).textContent();
    await updateRecoveryBackup(page, { keep_last: 8, verified_at: 1_700_000_001_000,
      destination: { connection_name: 'Renamed fixture storage', destination_id: 'a'.repeat(64), endpoint: 'https://storage.example.test', bucket: 'backups', region: 'us-east-1', prefix: '' } });
    await choose(page); await expect(words(page)).toHaveValue('synthetic unsent draft'); await expect(words(page)).toBeFocused();
    await expect(recoveryNode(page, 'selected')).toContainText('Renamed fixture storage'); await expect(feedback(page)).toHaveText(message!); await readOnly(page);
  });

  test('keeps the linked required error across reselection and removes it when corrected', async ({ page }) => {
    await submit(page); const error = recoveryNode(page, 'words-error'), description = await words(page).getAttribute('aria-describedby');
    await expect(words(page)).toHaveAttribute('aria-invalid', 'true'); await choose(page);
    await expect(words(page)).toHaveAttribute('aria-invalid', 'true'); await expect(words(page)).toHaveAttribute('aria-describedby', description!);
    await expect(error).toBeVisible(); await expect(error).toContainText('Enter the backup'); await expect(words(page)).toBeFocused();
    await words(page).fill('synthetic corrected words'); await expect(words(page)).not.toHaveAttribute('aria-invalid'); await expect(error).toBeHidden(); await readOnly(page);
  });

  test('keeps a known word rejection across reselection while receipts block retry', async ({ page }) => {
    await words(page).fill('synthetic incomplete words'); await submit(page); await expect(words(page)).toHaveValue('');
    await release(page, 'start-drill', 0, 'invalid-args'); await expect(feedback(page)).toContainText('request was rejected');
    const message = await feedback(page).textContent(), description = await words(page).getAttribute('aria-describedby');
    await choose(page); await expect(feedback(page)).toHaveText(message!); await expect(words(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(words(page)).toHaveAttribute('aria-describedby', description!); await expect(recoveryNode(page, 'words-error')).toContainText('all 24 words');
    await expect(words(page)).toBeFocused(); await expect(start(page)).toBeDisabled();
    await words(page).fill('synthetic corrected draft'); await expect(feedback(page)).toHaveText(''); await expect(words(page)).not.toHaveAttribute('aria-invalid');
    await choose(page); await expect(words(page)).toHaveValue('synthetic corrected draft'); await page.keyboard.press('Enter');
    expect(await count(page, 'start-drill')).toBe(1); await release(page, 'drills', 0); await expect(start(page)).toBeEnabled();
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['start-drill']);
  });

  test('keeps uncertainty and newer words through reselection and failed reads, then requires an explicit retry', async ({ page }) => {
    await words(page).fill('synthetic submitted words'); await submit(page); await expect(words(page)).toHaveValue(''); await release(page, 'start-drill', 0, 'error');
    await expect(feedback(page)).toContainText('could not be confirmed'); const warning = await feedback(page).textContent();
    await words(page).fill('synthetic newer draft'); await choose(page);
    await expect(words(page)).toHaveValue('synthetic newer draft'); await expect(feedback(page)).toHaveText(warning!); await expect(start(page)).toBeDisabled();
    await page.keyboard.press('Enter'); expect(await count(page, 'start-drill')).toBe(1);
    await release(page, 'drills', 0, 'error'); await choose(page); await expect(start(page)).toBeDisabled();
    await expect(words(page)).toHaveValue('synthetic newer draft'); await expect(feedback(page)).toHaveText(warning!);
    await activateRecoveryRefresh(page); await release(page, 'drills', 1); await choose(page); await expect(start(page)).toBeEnabled();
    await expect(words(page)).toHaveValue('synthetic newer draft'); await expect(feedback(page)).toHaveText(warning!); expect(await count(page, 'start-drill')).toBe(1);
    await submit(page); await expect(words(page)).toHaveValue(''); expect(await count(page, 'start-drill')).toBe(2);
    const calls = await page.evaluate(() => window.__backupStatus.calls.filter(call => call.kind === 'start-drill'));
    expect(calls[1]!.policy).not.toEqual(calls[0]!.policy); expect(JSON.stringify(calls)).not.toContain('synthetic');
    await release(page, 'start-drill', 1); await expect(feedback(page)).toContainText('server is running');
    await choose(page); await expect(feedback(page)).toContainText('server is running'); await expect(start(page)).toBeDisabled();
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['start-drill', 'start-drill']);
  });

  const changed: Array<[string, Partial<ArchiveRemoteBackup>]> = [
    ['backup identifier', { operation_id: '32345678-1234-4234-8234-123456789abc' }],
    ['storage identity', { destination: { connection_name: 'Fixture backup storage', destination_id: 'c'.repeat(64), endpoint: 'https://storage.example.test', bucket: 'backups', region: 'us-east-1', prefix: '' } }],
    ['object location', { object_key: 'recued-backups/different/archive' }],
    ['checksum', { sha256: 'c'.repeat(64) }],
    ['byte count', { bytes: 8001 }],
  ];
  for (const [name, update] of changed) test(`clears words and field errors when the selected ${name} changes`, async ({ page }) => {
    await submit(page); await expect(words(page)).toHaveAttribute('aria-invalid', 'true');
    await words(page).evaluate((node: HTMLInputElement) => { node.value = 'synthetic unsent words'; });
    await updateRecoveryBackup(page, update); await expect(words(page)).toHaveValue(''); await expect(words(page)).toBeDisabled();
    await choose(page); await expect(words(page)).toHaveValue(''); await expect(words(page)).toBeFocused();
    await expect(words(page)).not.toHaveAttribute('aria-invalid'); await expect(words(page)).not.toHaveAttribute('aria-describedby');
    await expect(recoveryNode(page, 'words-error')).toBeHidden(); await expect(feedback(page)).toContainText('Enter the recovery key'); await readOnly(page);
  });
});

for (const width of [390]) test.describe(`Recovery selection freshness at ${width}px`, () => {
  const words = (page: Page) => recoveryNode(page, 'words');
  const start = (page: Page) => recoveryNode(page, 'start');
  const selected = (page: Page) => recoveryNode(page, 'selected');
  const feedback = (page: Page) => recoveryNode(page, 'feedback');
  const submit = async (page: Page) => { await start(page).focus(); await page.keyboard.press('Enter'); };
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: 900 }); await openRecovery(page); });
  const stale: Array<[string, Partial<ArchiveRemoteBackup> | null, string]> = [
    ['pruned', { state: 'pruned' }, 'no longer verified'],
    ['pruning', { state: 'pruning' }, 'no longer verified'],
    ['unconfirmed', { state: 'unconfirmed' }, 'no longer verified'],
    ['missing', null, 'current history'],
    ['checksum', { sha256: 'c'.repeat(64) }, 'details changed'],
    ['object', { object_key: 'recued-backups/changed/archive' }, 'details changed'],
    ['size', { bytes: 8001 }, 'details changed'],
    ['storage', { destination: { connection_name: 'Fixture backup storage', destination_id: 'c'.repeat(64), endpoint: 'https://storage.example.test', bucket: 'backups', region: 'us-east-1', prefix: '' } }, 'details changed'],
  ];
  for (const [name, update, message] of stale) test(`clears the selected ${name} copy, explains why and requires a new choice`, async ({ page }) => {
    await submit(page); await expect(words(page)).toHaveAttribute('aria-invalid', 'true');
    await words(page).evaluate((node: HTMLInputElement) => { node.value = 'synthetic private draft'; }); await words(page).focus();
    const input = await words(page).elementHandle(), first = await recoveryNode(page, 'last-refreshed').getAttribute('datetime');
    await page.evaluate(update => { window.__backupStatus.setRecoveryBackup(update); window.__backupStatus.refresh(); }, update);
    await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await expect(words(page)).toHaveValue(''); await expect(words(page)).toBeDisabled(); await expect(start(page)).toBeDisabled();
    await expect(selected(page)).toContainText(message); await expect(selected(page)).toBeFocused(); await expect(selected(page)).toHaveAttribute('role', 'status');
    await expect(words(page)).not.toHaveAttribute('aria-invalid'); await expect(words(page)).not.toHaveAttribute('aria-describedby'); await expect(recoveryNode(page, 'words-error')).toBeHidden();
    await expect(feedback(page)).toHaveText(''); await expect(recoveryNode(page, 'last-refreshed')).toHaveAttribute('datetime', first!);
    await release(page, 'drills', 0); await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
    expect(await input!.evaluate(node => node.isConnected && node === document.querySelector('[data-drill-words]'))).toBe(true);
    await updateRecoveryBackup(page, { state: 'verified' }, 2, 1); await expect(start(page)).toBeDisabled(); await expect(words(page)).toHaveValue('');
    await expect(selected(page)).toContainText(message); await page.locator('[data-remote-backup-drill]').click();
    await expect(words(page)).toBeEnabled(); await expect(words(page)).toHaveValue(''); await expect(words(page)).toBeFocused(); await expect(start(page)).toBeEnabled();
    await readOnly(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('preserves a matching draft, validation and focus through a failed remote read and updates display metadata on recovery', async ({ page }) => {
    await submit(page); const description = await words(page).getAttribute('aria-describedby');
    await words(page).evaluate((node: HTMLInputElement) => { node.value = 'synthetic private draft'; }); await words(page).focus();
    await page.evaluate(() => window.__backupStatus.refresh()); await release(page, 'destinations', 1); await release(page, 'history', 1, 'error');
    await release(page, 'health', 1); await release(page, 'integrity', 1); await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
    await expect(words(page)).toHaveValue('synthetic private draft'); await expect(words(page)).toBeFocused(); await expect(words(page)).toHaveAttribute('aria-invalid', 'true');
    await updateRecoveryBackup(page, { keep_last: 8, destination: { connection_name: 'Renamed fixture storage', destination_id: 'a'.repeat(64), endpoint: 'https://storage.example.test', bucket: 'backups', region: 'us-east-1', prefix: '' } }, 2, 0);
    await expect(selected(page)).toContainText('Renamed fixture storage'); await expect(words(page)).toHaveValue('synthetic private draft'); await expect(words(page)).toBeFocused();
    await expect(words(page)).toHaveAttribute('aria-describedby', description!); await expect(words(page)).toHaveAttribute('aria-invalid', 'true'); await readOnly(page);
  });

  test('keeps an unconfirmed request warning when a later history refresh removes its selected copy', async ({ page }) => {
    await words(page).fill('synthetic submitted words'); await submit(page); await release(page, 'start-drill', 0, 'error');
    await expect(feedback(page)).toContainText('could not be confirmed'); const warning = await feedback(page).textContent();
    await release(page, 'drills', 0); await words(page).fill('synthetic newer draft'); await page.getByRole('button', { name: 'Outside panel', exact: true }).focus();
    await updateRecoveryBackup(page, null, 1, 1); await expect(words(page)).toHaveValue(''); await expect(words(page)).toBeDisabled(); await expect(start(page)).toBeDisabled();
    await expect(selected(page)).toContainText('current history'); await expect(feedback(page)).toHaveText(warning!);
    await expect(page.getByRole('button', { name: 'Outside panel', exact: true })).toBeFocused();
    expect(await count(page, 'start-drill')).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['start-drill']);
  });

  for (const outcome of ['success', 'error', 'invalid-args'] as const) test(`does not restore a cleared selection when an earlier start returns ${outcome}`, async ({ page }) => {
    await words(page).fill('synthetic submitted words'); await submit(page); await expect(words(page)).toHaveValue('');
    await page.getByRole('button', { name: 'Outside panel', exact: true }).focus();
    await page.evaluate(() => { window.__backupStatus.setRecoveryBackup(null); window.__backupStatus.refresh(); });
    await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await expect(selected(page)).toContainText('current history'); const message = await selected(page).textContent();
    await expect(feedback(page)).toContainText('Starting'); await release(page, 'start-drill', 0, outcome);
    await expect(feedback(page)).toContainText(outcome === 'success' ? 'server is running' : outcome === 'error' ? 'could not be confirmed' : 'Choose a verified backup');
    await release(page, 'drills', 0); await expect(words(page)).toHaveValue(''); await expect(words(page)).toBeDisabled(); await expect(start(page)).toBeDisabled();
    await expect(words(page)).not.toHaveAttribute('aria-invalid'); await expect(recoveryNode(page, 'words-error')).toBeHidden(); await expect(selected(page)).toHaveText(message!);
    await expect(page.getByRole('button', { name: 'Outside panel', exact: true })).toBeFocused();
    expect(await count(page, 'start-drill')).toBe(1); expect(await page.evaluate(() => JSON.stringify(window.__backupStatus.calls))).not.toContain('synthetic');
  });

  test('invalidates a copy immediately after an explicit stored-copy check without waiting for a history poll', async ({ page }) => {
    await words(page).fill('synthetic private draft'); await page.evaluate(() => window.__backupStatus.setRecoveryBackup({ state: 'unconfirmed' }));
    const check = page.locator('[data-remote-backup-check]'); await check.focus(); await page.keyboard.press('Enter'); await release(page, 'check');
    await expect(words(page)).toHaveValue(''); await expect(words(page)).toBeDisabled(); await expect(start(page)).toBeDisabled();
    await expect(selected(page)).toContainText('no longer verified'); await expect(check).toBeFocused();
    expect(await count(page, 'history')).toBe(1); expect(await count(page, 'start-drill')).toBe(0); expect(await count(page, 'check')).toBe(1);
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['check']);
  });
});

for (const width of [390]) test.describe(`Recovery word entry errors at ${width}px`, () => {
  const words = (page: Page) => recoveryNode(page, 'words');
  const error = (page: Page) => recoveryNode(page, 'words-error');
  const start = (page: Page) => recoveryNode(page, 'start');
  const submit = async (page: Page) => { await start(page).focus(); await page.keyboard.press('Enter'); };
  const expectLinkedError = async (page: Page, message: string) => {
    await expect(words(page)).toHaveAttribute('aria-invalid', 'true'); await expect(error(page)).toBeVisible();
    await expect(error(page)).toHaveText(message);
    await expect(words(page)).toHaveAttribute('aria-describedby', (await error(page).getAttribute('id'))!);
  };
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: 900 }); await openRecovery(page); });

  for (const value of ['', '   ']) test(`focuses and identifies empty entry ${JSON.stringify(value)} without a request`, async ({ page }) => {
    await words(page).fill(value); await expect(words(page)).not.toHaveAttribute('aria-invalid');
    const first = await recoveryNode(page, 'last-refreshed').getAttribute('datetime'), input = await words(page).elementHandle();
    await submit(page); await expectLinkedError(page, 'Enter the backup’s 24-word recovery key.');
    await expect(words(page)).toBeFocused(); await expect(words(page)).toHaveValue('');
    expect(await words(page).evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })).toBe(true);
    await words(page).fill('synthetic corrected words'); await expect(words(page)).not.toHaveAttribute('aria-invalid');
    await expect(words(page)).not.toHaveAttribute('aria-describedby'); await expect(error(page)).toBeHidden();
    expect(await input!.evaluate(node => node.isConnected && node === document.querySelector('[data-drill-words]'))).toBe(true);
    await expect(recoveryNode(page, 'last-refreshed')).toHaveAttribute('datetime', first!);
    expect(await count(page, 'start-drill')).toBe(0); await readOnly(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  for (const origin of ['words', 'start']) test(`returns a rejected request from ${origin} to the words field and keeps retry blocked until receipts load`, async ({ page }) => {
    await words(page).fill('synthetic incomplete words');
    if (origin === 'words') { await words(page).focus(); await page.keyboard.press('Enter'); } else await submit(page);
    await expect(words(page)).toHaveValue(''); await expect(words(page)).toBeDisabled();
    await release(page, 'start-drill', 0, 'invalid-args');
    await expectLinkedError(page, 'Use all 24 words of this backup’s recovery key.'); await expect(words(page)).toBeEnabled(); await expect(words(page)).toBeFocused();
    await expect(recoveryNode(page, 'feedback')).toContainText('request was rejected'); await expect(start(page)).toBeDisabled();
    await expect(recoveryNode(page, 'refresh-status')).toContainText('Refreshing recovery receipts');
    await words(page).fill('synthetic corrected words'); await expect(words(page)).not.toHaveAttribute('aria-invalid');
    await expect(error(page)).toBeHidden(); await expect(recoveryNode(page, 'feedback')).toHaveText('');
    await page.keyboard.press('Enter'); expect(await count(page, 'start-drill')).toBe(1);
    await release(page, 'drills', 0, 'error'); await expect(start(page)).toBeDisabled();
    await activateRecoveryRefresh(page); await words(page).focus(); await release(page, 'drills', 1);
    await expect(start(page)).toBeEnabled(); await expect(words(page)).toHaveValue('synthetic corrected words'); await expect(words(page)).toBeFocused();
    expect(await count(page, 'start-drill')).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['start-drill']);
    expect(await page.evaluate(() => JSON.stringify(window.__backupStatus.calls))).not.toContain('synthetic');
    await expect(page.locator('[data-remote-backups]')).not.toContainText('private provider');
  });

  test('marks a rejected entry without moving focus from another control or refreshing away its error', async ({ page }) => {
    await words(page).fill('synthetic incomplete words'); await submit(page); await recoveryRefresh(page).focus();
    await release(page, 'start-drill', 0, 'invalid-args');
    await expectLinkedError(page, 'Use all 24 words of this backup’s recovery key.'); await expect(recoveryRefresh(page)).toBeFocused();
    await release(page, 'drills', 0); await expect(start(page)).toBeEnabled();
    await expectLinkedError(page, 'Use all 24 words of this backup’s recovery key.'); await expect(recoveryRefresh(page)).toBeFocused();
    expect(await count(page, 'start-drill')).toBe(1);
  });

  test('preserves a newer autofilled draft when an older submitted entry is rejected', async ({ page }) => {
    await words(page).fill('synthetic submitted words'); await submit(page); await recoveryRefresh(page).focus();
    await words(page).evaluate((node: HTMLInputElement) => { node.value = 'synthetic newer draft'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await release(page, 'start-drill', 0, 'invalid-args');
    await expect(recoveryNode(page, 'feedback')).toContainText('Your newer entry has not been sent.');
    await expect(words(page)).toHaveValue('synthetic newer draft'); await expect(words(page)).not.toHaveAttribute('aria-invalid');
    await expect(error(page)).toBeHidden(); await expect(recoveryRefresh(page)).toBeFocused();
    await release(page, 'drills', 0); await expect(start(page)).toBeEnabled(); expect(await count(page, 'start-drill')).toBe(1);
  });

  test('retains an uncertain-request warning through editing, required errors and receipt refresh', async ({ page }) => {
    await words(page).fill('synthetic submitted words'); await submit(page); await release(page, 'start-drill', 0, 'error');
    const feedback = recoveryNode(page, 'feedback'); await expect(feedback).toContainText('could not be confirmed');
    const warning = await feedback.textContent(); await words(page).fill('synthetic corrected words'); await expect(feedback).toHaveText(warning!);
    await expect(words(page)).not.toHaveAttribute('aria-invalid'); await release(page, 'drills', 0); await expect(start(page)).toBeEnabled();
    await words(page).fill(''); await submit(page); await expectLinkedError(page, 'Enter the backup’s 24-word recovery key.');
    await expect(feedback).toHaveText(warning!); await activateRecoveryRefresh(page); await release(page, 'drills', 1);
    await expect(start(page)).toBeEnabled(); await expect(feedback).toHaveText(warning!);
    await expectLinkedError(page, 'Enter the backup’s 24-word recovery key.'); expect(await count(page, 'start-drill')).toBe(1);
  });

  test('resets errors on a different selection and ignores a rejected request after disposal', async ({ page }) => {
    await submit(page); await expectLinkedError(page, 'Enter the backup’s 24-word recovery key.');
    await words(page).fill('synthetic unsent draft'); await updateRecoveryBackup(page, { operation_id: '32345678-1234-4234-8234-123456789abc' });
    await openBackupCopyDetails(page.locator('[data-remote-backup-id]').first());
    await page.locator('[data-remote-backup-drill]').click();
    await expect(words(page)).toHaveValue(''); await expect(words(page)).not.toHaveAttribute('aria-invalid'); await expect(error(page)).toBeHidden();
    await words(page).fill('synthetic submitted words'); await submit(page);
    await page.evaluate(() => window.__backupStatus.dispose());
    const before = await page.locator('[data-remote-backups]').textContent(); await release(page, 'start-drill', 0, 'invalid-args');
    await expect.poll(() => page.locator('[data-remote-backups]').textContent()).toBe(before); await expect(words(page)).toHaveValue('');
    await expect(words(page)).toBeDisabled(); await expect(words(page)).not.toHaveAttribute('aria-invalid'); await expect(error(page)).toBeHidden();
    expect(await count(page, 'start-drill')).toBe(1); expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['start-drill']);
  });
});

for (const width of [390]) {
  test(`Recovery receipt refresh clears read errors and preserves selection, drafts and focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await openRecovery(page);
    const words = recoveryNode(page, 'words'), selected = await recoveryNode(page, 'selected').textContent();
    const feedback = await recoveryNode(page, 'feedback').textContent();
    const initialCalls = await count(page, 'drills');
    const first = await recoveryNode(page, 'last-refreshed').getAttribute('datetime');
    await expect(recoveryNode(page, 'empty')).toBeVisible();
    await words.fill('synthetic unsubmitted draft'); const input = await words.elementHandle();
    await activateRecoveryRefresh(page); await page.keyboard.press('Enter');
    await expect(recoveryRefresh(page)).toBeFocused(); await expect(recoveryRefresh(page)).not.toHaveAttribute('disabled');
    await expect(recoveryRefresh(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(recoveryRefresh(page)).toHaveAttribute('aria-busy', 'true');
    await expect(recoveryNode(page, 'refresh-status')).toContainText('Refreshing recovery receipts…');
    expect(await count(page, 'drills')).toBe(initialCalls + 1);
    await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'drills', 0, 'error');
    await expect(recoveryNode(page, 'refresh-status')).toContainText('Recovery receipts could not be checked.');
    await expect(recoveryNode(page, 'last-refreshed')).toHaveAttribute('datetime', first!);
    await expect(recoveryNode(page, 'start')).toBeDisabled(); await expect(recoveryNode(page, 'empty')).toBeHidden();
    await expect(recoveryNode(page, 'feedback')).toHaveText(feedback!);
    await activateRecoveryRefresh(page); await words.focus();
    await expect(recoveryNode(page, 'last-refreshed')).toHaveAttribute('datetime', first!);
    await page.evaluate(() => window.__backupStatus.advance(2_000)); await release(page, 'drills', 1);
    await expect(recoveryRefresh(page)).toHaveAttribute('aria-busy', 'false');
    await expect(recoveryNode(page, 'refresh-status')).not.toContainText('could not be checked');
    await expect(recoveryNode(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:23.000Z');
    await expect(recoveryNode(page, 'start')).toBeEnabled(); await expect(recoveryNode(page, 'empty')).toBeVisible();
    await expect(recoveryNode(page, 'selected')).toHaveText(selected!); await expect(recoveryNode(page, 'feedback')).toHaveText(feedback!);
    await expect(words).toHaveValue('synthetic unsubmitted draft'); await expect(words).toBeFocused();
    expect(await input!.evaluate(node => node.isConnected && node === document.querySelector('[data-drill-words]'))).toBe(true);
    await expect(page.locator('[data-remote-backups]')).not.toContainText('private provider');
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  for (const action of ['cancel', 'cleanup'] as const) for (const oldFirst of [true, false]) {
    test(`Recovery receipt ${action} keeps its message through an overlapping read (old first: ${oldFirst}) at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await openRecovery(page, action === 'cancel' ? 'running' : 'cleanup');
      const initialCalls = await count(page, 'drills'), first = await recoveryNode(page, 'last-refreshed').getAttribute('datetime');
      const selected = await recoveryNode(page, 'selected').textContent(), words = recoveryNode(page, 'words');
      await activateRecoveryRefresh(page);
      await recoveryNode(page, 'history').getByRole('button', { name: action === 'cancel' ? 'Cancel test' : 'Retry cleanup', exact: true }).click();
      await words.fill('synthetic newer draft');
      if (oldFirst) {
        await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'drills', 0);
        await expect(recoveryNode(page, 'refresh-status')).toContainText('Waiting to refresh recovery receipts after the current action.');
      }
      await release(page, `${action}-drill`);
      const message = action === 'cancel' ? 'Cancellation requested.' : 'Temporary files are gone.';
      await expect(recoveryNode(page, 'feedback')).toContainText(message);
      if (!oldFirst) { await page.evaluate(() => window.__backupStatus.advance(1_000)); await release(page, 'drills', 0, 'error'); }
      await expect.poll(() => count(page, 'drills')).toBe(initialCalls + 2);
      await expect(recoveryNode(page, 'last-refreshed')).toHaveAttribute('datetime', first!);
      await expect(recoveryNode(page, 'refresh-status')).toContainText('Refreshing recovery receipts…');
      await expect(recoveryNode(page, 'refresh-status')).not.toContainText('could not be checked');
      await page.evaluate(() => window.__backupStatus.advance(4_000)); await release(page, 'drills', 1);
      await expect(recoveryRefresh(page)).toHaveAttribute('aria-busy', 'false');
      await expect(recoveryNode(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:25.000Z');
      await expect(recoveryNode(page, 'feedback')).toContainText(message);
      await expect(recoveryNode(page, 'selected')).toHaveText(selected!); await expect(words).toHaveValue('synthetic newer draft');
      await expect(words).toBeFocused(); expect(await count(page, `${action}-drill`)).toBe(1);
      expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([`${action}-drill`]);
      await expect(page.locator('[data-remote-backups]')).not.toContainText('private provider');
    });
  }

  for (const outcome of ['success', 'error'] as const) {
    test(`Recovery receipt refresh waits for a ${outcome} start and keeps its feedback through retry at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await openRecovery(page);
      const words = recoveryNode(page, 'words'), initialCalls = await count(page, 'drills');
      const first = await recoveryNode(page, 'last-refreshed').getAttribute('datetime');
      await words.fill('synthetic setup words'); await recoveryNode(page, 'start').focus(); await page.keyboard.press('Enter');
      await expect(words).toHaveValue(''); await expect(recoveryNode(page, 'refresh-status')).toContainText('Waiting to refresh recovery receipts');
      await activateRecoveryRefresh(page); expect(await count(page, 'drills')).toBe(initialCalls);
      await release(page, 'start-drill', 0, outcome);
      const message = outcome === 'success' ? 'server is running the test' : 'could not be confirmed';
      await expect(recoveryNode(page, 'feedback')).toContainText(message);
      await expect.poll(() => count(page, 'drills')).toBe(initialCalls + 1);
      await expect(recoveryNode(page, 'last-refreshed')).toHaveAttribute('datetime', first!);
      await words.fill('synthetic newer draft'); await release(page, 'drills', 0, 'error');
      await expect(recoveryNode(page, 'refresh-status')).toContainText('could not be checked');
      await expect(recoveryNode(page, 'feedback')).toContainText(message);
      await activateRecoveryRefresh(page); await words.focus();
      await page.evaluate(() => window.__backupStatus.advance(3_000)); await release(page, 'drills', 1);
      await expect(recoveryRefresh(page)).toHaveAttribute('aria-busy', 'false');
      await expect(recoveryNode(page, 'refresh-status')).not.toContainText('could not be checked');
      await expect(recoveryNode(page, 'last-refreshed')).toHaveAttribute('datetime', '2023-11-14T22:13:23.000Z');
      await expect(recoveryNode(page, 'feedback')).toContainText(message);
      await expect(words).toHaveValue('synthetic newer draft'); await expect(words).toBeFocused();
      expect(await count(page, 'start-drill')).toBe(1);
      expect(await page.evaluate(() => JSON.stringify(window.__backupStatus.calls))).not.toContain('synthetic setup words');
      expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual(['start-drill']);
    });
  }

  test(`Backup setup validation follows field order and clears recovery words on submission at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page);
    await openBackupDisclosure(page, 'schedule');
    const input = (name: string) => page.locator(`[data-unattended-${name}]`);
    const submit = async () => { await input('save').focus(); await page.keyboard.press('Enter'); };
    await input('time').fill(''); await input('keep').fill('31'); await submit();
    await expect(input('destination')).toBeFocused();
    for (const name of ['destination', 'time', 'keep', 'words']) {
      await expect(input(name)).toHaveAttribute('aria-invalid', 'true');
      await expect(input(`${name}-error`)).toBeVisible();
      const message = await input(`${name}-error`).textContent();
      await expect(input(name)).toHaveAccessibleDescription(message!);
    }
    await input('destination').selectOption('Fixture backup storage');
    await expect(input('destination')).not.toHaveAttribute('aria-invalid');
    await submit(); await expect(input('time')).toBeFocused();
    await page.evaluate(() => window.__backupStatus.refresh());
    await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
    await expect(input('time')).toBeFocused(); await expect(input('time')).toHaveValue('');
    await expect(input('keep')).toHaveValue('31'); await readOnly(page);
    await input('time').fill('17:45'); await submit(); await expect(input('keep')).toBeFocused();
    await input('keep').fill('5'); await submit(); await expect(input('words')).toBeFocused();
    await input('words').fill('synthetic setup words');
    await expect(input('words')).not.toHaveAttribute('aria-invalid');
    await submit(); await expect.poll(() => count(page, 'save-unattended')).toBe(1);
    await expect(input('words')).toHaveValue('');
    await input('keep').fill('6'); await expect(input('words')).not.toHaveAttribute('aria-invalid');
    await release(page, 'save-unattended');
    await expect(input('feedback')).toContainText('newer edits'); await expect(input('keep')).toHaveValue('6');
    await expect(input('keep')).toBeFocused();
    expect(await page.evaluate(() => JSON.stringify(window.__backupStatus.calls))).not.toContain('synthetic setup words');
    await expect(page.locator('[data-remote-backups]')).not.toContainText('synthetic setup words');
    expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  for (const kind of ['health', 'integrity'] as const) {
    test(`Backup ${kind} validation identifies invalid fields and preserves drafts at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page);
      const input = field(page, kind), name = kind === 'health' ? 'hours' : 'time';
      const error = page.locator(`[data-backup-${kind}-${name}-error]`);
      const message = kind === 'health' ? 'Enter a whole number from 1 to 8760 hours.' : 'Enter a UTC time, such as 02:00.';
      await input.fill(''); await save(page, kind).focus(); await page.keyboard.press('Enter');
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await expect(error).toHaveText(message); await expect(error).toBeVisible();
      await expect(input).toHaveAccessibleDescription(message);
      await page.evaluate(() => window.__backupStatus.refresh());
      await storage(page, 1); await release(page, 'health', 1); await release(page, 'integrity', 1);
      await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
      await expect(input).toBeFocused(); await expect(input).toHaveValue('');
      await expect(error).toHaveText(message); await readOnly(page);
      await input.fill(kind === 'health' ? '72' : '17:45');
      await expect(input).not.toHaveAttribute('aria-invalid'); await expect(error).toBeHidden();
      await save(page, kind).focus(); await page.keyboard.press('Enter');
      await expect.poll(() => count(page, `save-${kind}`)).toBe(1);
      await release(page, `save-${kind}`); await release(page, kind, 2);
      await expect(page.locator(`[data-backup-${kind}-feedback]`)).toContainText('saved');
      expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
    });
  }

  test(`Backup status refresh follows both reads and keeps drafts and focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await open(page, false);
    await expect(refresh(page)).toHaveText('Refreshing backup status…');
    await expect(refresh(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await expect(refresh(page)).not.toHaveAttribute('disabled');
    await expect(freshness(page, 'health')).toContainText('No successful status refresh yet.');
    await refresh(page).focus(); await page.keyboard.press('Enter');
    expect(await count(page, 'history')).toBe(1); expect(await count(page, 'health')).toBe(1);
    await release(page, 'health'); await expect(time(page, 'health')).toBeVisible();
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await release(page, 'integrity'); await expect(refresh(page)).toHaveText('Refresh backup status');
    await expect(refresh(page)).toBeFocused();

    const hours = field(page, 'health'), schedule = field(page, 'integrity');
    await hours.fill('72'); await schedule.fill('17:45');
    const hoursNode = await hours.elementHandle(), scheduleNode = await schedule.elementHandle();
    const first = await time(page, 'health').getAttribute('datetime');
    await activate(page);
    await refresh(page).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    expect(await count(page, 'history')).toBe(2); expect(await count(page, 'health')).toBe(2);
    await storage(page, 1);
    await expect(page.locator('[data-remote-backups-status]')).toHaveText('Showing the latest remote backup receipts.');
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await expect(time(page, 'health')).toHaveAttribute('datetime', first!);
    await page.evaluate(() => window.__backupStatus.advance(1_000));
    await release(page, 'health', 1);
    await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await schedule.focus();
    await page.evaluate(() => window.__backupStatus.advance(1_000));
    await release(page, 'integrity', 1);
    await expect(refresh(page)).toHaveText('Refresh backup status');
    await expect(schedule).toBeFocused(); await expect(hours).toHaveValue('72'); await expect(schedule).toHaveValue('17:45');
    await expect(time(page, 'health')).toHaveAttribute('datetime', '2023-11-14T22:13:21.000Z');
    await expect(time(page, 'integrity')).toHaveAttribute('datetime', '2023-11-14T22:13:22.000Z');
    expect(await hoursNode!.evaluate(node => node.isConnected && node === document.querySelector('[data-backup-health-hours]'))).toBe(true);
    expect(await scheduleNode!.evaluate(node => node.isConnected && node === document.querySelector('[data-backup-integrity-time]'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await readOnly(page);
  });

  for (const kind of ['health', 'integrity'] as const) {
    test(`Backup ${kind} status retains successful time on a failed refresh and recovers at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await open(page);
      const prior = await time(page, kind).getAttribute('datetime');
      const input = field(page, kind), draft = kind === 'health' ? '72' : '17:45';
      await input.fill(draft); await activate(page); await storage(page, 1);
      await release(page, kind === 'health' ? 'integrity' : 'health', 1);
      await page.evaluate(() => window.__backupStatus.advance(1_000));
      await release(page, kind, 1, kind === 'health' ? 'error' : 'unavailable');
      await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
      await expect(refresh(page)).toBeFocused();
      await expect(freshness(page, kind)).toContainText('Latest status refresh failed.');
      await expect(time(page, kind)).toHaveAttribute('datetime', prior!);
      await expect(save(page, kind)).toBeDisabled(); await expect(input).toHaveValue(draft);
      await expect(page.locator('[data-remote-backups]')).not.toContainText('private provider');
      await activate(page); await storage(page, 2);
      await expect(time(page, kind)).toHaveAttribute('datetime', prior!);
      await release(page, kind === 'health' ? 'integrity' : 'health', 2);
      await page.evaluate(() => window.__backupStatus.advance(1_000));
      await release(page, kind, 2);
      await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
      await expect(refresh(page)).toBeFocused();
      await expect(time(page, kind)).toHaveAttribute('datetime', '2023-11-14T22:13:22.000Z');
      await expect(freshness(page, kind)).not.toContainText('failed');
      await expect(input).toHaveValue(draft); await readOnly(page);
    });

    for (const readFails of [true, false]) for (const oldFirst of [true, false]) {
      test(`Backup ${kind} status recovers an uncertain save and stale read (read fails: ${readFails}, old first: ${oldFirst}) at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 }); await open(page);
        const input = field(page, kind), draft = kind === 'health' ? '72' : '07:00';
        const prior = await time(page, kind).getAttribute('datetime');
        await input.fill(kind === 'health' ? '48' : '05:00');
        await page.evaluate(() => window.__backupStatus.refresh());
        await storage(page, 1); await release(page, kind === 'health' ? 'integrity' : 'health', 1);
        await save(page, kind).focus(); await page.keyboard.press('Enter');
        await input.fill(draft);
        if (oldFirst) {
          await release(page, kind, 1, readFails ? 'error' : 'success');
          await expect(freshness(page, kind)).toContainText('Waiting to refresh status after the save.');
        }
        await release(page, `save-${kind}`, 0, 'error');
        await expect(page.locator(`[data-backup-${kind}-feedback]`)).toContainText('could not be confirmed');
        await blockedPolicyRetry(page, kind);
        if (!oldFirst) await release(page, kind, 1, readFails ? 'error' : 'success');
        await expect.poll(() => count(page, kind)).toBe(3);
        await blockedPolicyRetry(page, kind); await input.focus();
        await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
        await expect(freshness(page, kind)).toContainText('Refreshing status…');
        await expect(time(page, kind)).toHaveAttribute('datetime', prior!);
        await page.evaluate(() => window.__backupStatus.advance(4_000));
        await release(page, kind, 2);
        await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
        await expect(time(page, kind)).toHaveAttribute('datetime', '2023-11-14T22:13:24.000Z');
        await expect(input).toHaveValue(draft); await expect(input).toBeFocused();
        await expect(freshness(page, kind)).not.toContainText('failed');
        await expect(page.locator('[data-remote-backups]')).not.toContainText('private provider');
        expect(await count(page, `save-${kind}`)).toBe(1);
        expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
      });
    }

    for (const oldFirst of [true, false]) {
      test(`Backup ${kind} status fences a pre-save read (old first: ${oldFirst}) at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 }); await open(page);
        const input = field(page, kind), submitted = kind === 'health' ? '48' : '05:00', newer = kind === 'health' ? '72' : '07:00';
        const prior = await time(page, kind).getAttribute('datetime');
        await input.fill(submitted);
        await page.evaluate(() => window.__backupStatus.refresh());
        await storage(page, 1); await release(page, kind === 'health' ? 'integrity' : 'health', 1);
        await save(page, kind).focus(); await page.keyboard.press('Enter');
        await expect.poll(() => count(page, `save-${kind}`)).toBe(1);
        await input.fill(newer); await expect(input).toBeFocused();
        await expect(freshness(page, kind)).toContainText('Waiting to refresh status after the save.');
        if (oldFirst) {
          await release(page, kind, 1);
          expect(await count(page, kind)).toBe(2);
          await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
          await expect(time(page, kind)).toHaveAttribute('datetime', prior!);
        }
        await release(page, `save-${kind}`);
        if (!oldFirst) {
          expect(await count(page, kind)).toBe(2);
          await expect(time(page, kind)).toHaveAttribute('datetime', prior!);
          await release(page, kind, 1);
        }
        await expect.poll(() => count(page, kind)).toBe(3);
        await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
        await expect(time(page, kind)).toHaveAttribute('datetime', prior!);
        await page.evaluate(() => window.__backupStatus.advance(3_000));
        await release(page, kind, 2);
        await expect(refresh(page)).toHaveAttribute('aria-busy', 'false');
        await expect(time(page, kind)).toHaveAttribute('datetime', '2023-11-14T22:13:23.000Z');
        await expect(input).toHaveValue(newer); await expect(input).toBeFocused();
        await expect(page.locator(kind === 'health' ? '[data-backup-health-feedback]' : '[data-backup-integrity-feedback]')).toContainText('newer edits');
        expect(await count(page, `save-${kind}`)).toBe(1);
        expect(await page.evaluate(() => window.__backupStatus.expensive)).toEqual([]);
      });
    }
  }
}
