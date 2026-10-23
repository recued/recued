import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { applyPreset, type QuietHoursGetResponse, type QuietHoursSetRequest, type ServerTimeZoneGetResponse, type ServerTimeZoneSetRequest } from '@recued/contracts';
import {
  HARNESS_URL, LIST_PREVIEW, SETTINGS_NAV_ITEM, SHARED_REFERENCE, SHARED_REFERENCE_ID,
  installFullAppHooks,
} from './helpers/full-app.js';

/** Settings browser journeys against the deterministic full-app harness. */
const SETTINGS_NAV = 'data-recued-settings-nav';
const SETTINGS_SUBTAB = 'data-recued-settings-subtab';
const EXPOSURE_CELL = 'data-recued-exposure-cell';
const EXPOSURE_PUBLIC_MCP = 'data-recued-exposure-public-mcp';
const EXPOSURE_MODAL_CANCEL = 'data-recued-exposure-modal-cancel';
const EXPOSURE_MODAL_SUBMIT = 'data-recued-exposure-modal-submit';
const CLEAR_THIS_BROWSER_CLEAR = 'data-recued-clear-this-browser-clear';
const CLEAR_THIS_BROWSER_CONFIRM = 'data-recued-clear-this-browser-confirm';
const CLEAR_THIS_BROWSER_CANCEL = 'data-recued-clear-this-browser-cancel';
const CLEAR_THIS_BROWSER_RETRY = 'data-recued-clear-this-browser-retry';
const CLEAR_THIS_BROWSER_RELOAD = 'data-recued-clear-this-browser-reload';
const CLEAR_THIS_BROWSER_STATUS = 'data-recued-clear-this-browser-status';
const ARCHIVE_BACKUP_START = 'data-recued-archive-backup-start';
const ARCHIVE_RESTORE_START = 'data-recued-archive-restore-start';
const ARCHIVE_BACKUP_MNEMONIC = 'data-recued-archive-backup-mnemonic';
const ARCHIVE_BACKUP_RUN = 'data-recued-archive-backup-run';
const ARCHIVE_BACKUP_PROGRESS = 'data-recued-archive-backup-progress';
const ARCHIVE_RESTORE_UPLOAD_INPUT = 'data-recued-archive-restore-upload';
const ARCHIVE_RESTORE_PATH = 'data-recued-archive-restore-path';
const ARCHIVE_RESTORE_MNEMONIC = 'data-recued-archive-restore-mnemonic';
const ARCHIVE_RESTORE_PREVIEW = 'data-recued-archive-restore-preview';
const ARCHIVE_RESTORE_ARM = 'data-recued-archive-restore-arm';
const ARCHIVE_RESTORE_COMMIT = 'data-recued-archive-restore-commit';
const ARCHIVE_PASSPORT_START = 'data-recued-archive-passport-start';
const ARCHIVE_BACKUP_BUSY = 'data-recued-archive-backup-busy';
const ARCHIVE_BACKUP_CANCEL = 'data-recued-archive-backup-cancel';
const TRANSPARENCY_TOGGLE = 'data-recued-transparency-toggle';
const LEARNING_TOGGLE = 'data-recued-learning-toggle';
const LEARNING_CASE = 'data-recued-learning-case';
const LEARNING_CASES_EMPTY = 'data-recued-learning-cases-empty';
const LEARNING_CASES_ERROR = 'data-recued-learning-cases-error';
const LEARNING_DRAFT = 'data-recued-learning-draft';
const LEARNING_DRAFT_CONFIRM = 'data-recued-learning-draft-confirm';
const LEARNING_DRAFT_ERROR = 'data-recued-learning-draft-error';
const LEARNING_DRAFT_PROMPT = 'data-recued-learning-draft-prompt';
const LEARNING_DRAFT_ROUTE = 'data-recued-execution-case-draft';
const LEARNING_FORGET = 'data-recued-learning-forget';
const LEARNING_FORGET_ERROR = 'data-recued-learning-forget-error';
const UPDATES_CHECK = 'data-recued-updates-check';
const UPDATES_STATUS = 'data-recued-updates-status';
const UPDATES_ERROR = 'data-recued-updates-error';
const UPDATES_APPLY = 'data-recued-updates-apply';
const UPDATES_ROLLBACK = 'data-recued-updates-rollback';
const UPDATES_MODE = 'data-recued-updates-mode';

const openServerAddressEditor = async (page: Page, activation: 'keyboard' | 'pointer' = 'keyboard') => {
  await page.evaluate(() => window.__app.setHash('#settings/servers'));
  const row = page.locator('[data-server-address-row]').first();
  const edit = row.locator('[data-server-address-edit]');
  await expect(edit).toBeVisible();
  if (activation === 'keyboard') { await edit.focus(); await page.keyboard.press('Enter'); }
  else await edit.click();
  const input = row.locator('[data-server-address-input]');
  await expect(input).toBeVisible();
  if (activation === 'keyboard') await expect(input).toBeFocused();
  return { row, input, edit, original: await input.inputValue() };
};

/** A held, local HTTP refusal exercises the production anonymous probe. */
const holdServerAddressProbe = async (page: Page) => {
  const url = new URL('/address-fixture/auth/identity-probe', HARNESS_URL);
  const state: { route: Route | null; requests: number } = { route: null, requests: 0 };
  await page.route(url.href, route => { state.route = route; state.requests += 1; });
  return {
    candidate: `${url.origin.replace(/^http/, 'ws')}/address-fixture/ws`,
    state,
    release: async (outcome: 'mismatch' | 'unreachable') => {
      await expect.poll(() => state.route !== null).toBe(true);
      const route = state.route;
      if (!route) throw new Error('No identity probe is waiting.');
      if (outcome === 'unreachable') await route.abort('failed');
      else await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    },
  };
};

installFullAppHooks();

declare global { interface Window {
  __quietHoursNavigation: { reads: number; writes: QuietHoursSetRequest[]; failNextSave: boolean; failNextRead: boolean };
} }
const quietNavPanel = (page: Page) => page.locator('[data-recued-quiet-hours-panel]');
const quietNavFrom = (page: Page) => quietNavPanel(page).getByLabel('Quiet hours start', { exact: true });
const quietNavTo = (page: Page) => quietNavPanel(page).getByLabel('Quiet hours end', { exact: true });
const quietNavSave = (page: Page) => quietNavPanel(page).getByRole('button', { name: 'Save', exact: true });
const quietNavCheckbox = (page: Page, kind: 'reminders' | 'approvals') => quietNavPanel(page)
  .locator(`[data-recued-quiet-hours-${kind === 'reminders' ? 'toggle' : 'approval'}]`);
const quietNavDraftPrompt = 'Discard the unsaved quiet hours window?';
const quietNavWorkPrompt = 'A quiet hours setting is still updating. Leave Settings anyway?';
const quietNavWindow = { from_minute: 1410, to_minute: 375 };
const quietNavWrites = (page: Page) => page.evaluate(() => window.__quietHoursNavigation.writes);
const quietNavLeave = (page: Page) => page.evaluate(() => window.__app.setHash('#yours/assets'));
const quietNavUnloadBlocked = (page: Page) => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
});
const openQuietNav = async (page: Page, width: number, holdRead = false, failRead = false) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(failRead => {
    type Reply = { result?: unknown; error?: { code: string; message: string } };
    let current: QuietHoursGetResponse = { policy: { enabled: true, from_minute: 1320, to_minute: 480,
      applies_to: ['notification'], updated_at: 1 }, can_arm: true, resolved_zone: 'Asia/Hong_Kong' };
    const timezone: ServerTimeZoneGetResponse = { setting: { mode: 'fixed', zone: 'Europe/London', updated_at: 1 },
      resolved_zone: 'Europe/London', host_zone: 'Europe/London' };
    const controls = { reads: 0, writes: [] as QuietHoursSetRequest[], failNextSave: false, failNextRead: failRead };
    window.__quietHoursNavigation = controls;
    Object.assign(window, { __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
      if (method === 'notification.quiet_hours.get') {
        controls.reads++;
        if (controls.failNextRead) { controls.failNextRead = false; return { error: { code: 'unavailable', message: 'Could not read quiet hours.' } }; }
        return { result: structuredClone(current) };
      }
      if (method === 'notification.quiet_hours.set') {
        const patch = args as QuietHoursSetRequest; controls.writes.push(structuredClone(patch));
        if (controls.failNextSave) { controls.failNextSave = false; return { error: { code: 'unavailable', message: 'Quiet hours save failed. Try again.' } }; }
        current = { ...current, policy: { ...current.policy, ...patch, updated_at: current.policy.updated_at + 1 } };
        return { result: structuredClone(current) };
      }
      if (method === 'server.timezone.get') return { result: timezone };
      return undefined;
    } });
  }, failRead);
  await page.goto(`${HARNESS_URL}?yours=demo&notifications=ready${holdRead ? '&hold_rpc=notification.quiet_hours.get' : ''}#settings/notifications`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (failRead) await expect(quietNavPanel(page).getByRole('alert')).toHaveText('Could not read quiet hours.');
  else if (!holdRead) { await expect(quietNavFrom(page)).toHaveValue('22:00'); await expect(quietNavTo(page)).toHaveValue('08:00'); }
};
const editQuietNav = async (page: Page) => { await quietNavFrom(page).fill('23:30'); await quietNavTo(page).fill('06:15'); };
const activateQuietNav = async (page: Page, kind: 'window' | 'reminders' | 'approvals') => {
  if (kind === 'window') await quietNavSave(page).press('Enter');
  else { const checkbox = quietNavCheckbox(page, kind); await checkbox.focus(); await checkbox.press('Space'); }
};

for (const width of [390, 1280]) {
  for (const which of ['from', 'to'] as const) {
    test(`Quiet hours navigation allows fully restored ${which} times through reload and departure at ${width}px`, async ({ page }) => {
      await openQuietNav(page, width);
      const field = which === 'from' ? quietNavFrom(page) : quietNavTo(page), original = await field.elementHandle();
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
      await field.fill(which === 'from' ? '21:30' : '09:15'); expect(await quietNavUnloadBlocked(page)).toBe(true);
      await field.fill(which === 'from' ? '22:00' : '08:00'); expect(await quietNavUnloadBlocked(page)).toBe(false);
      expect(await original!.evaluate(input => input.isConnected && input === document.activeElement)).toBe(true);
      expect(await quietNavWrites(page)).toEqual([]);
      await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
      await expect(quietNavFrom(page)).toHaveValue('22:00'); await expect(quietNavTo(page)).toHaveValue('08:00');
      expect(await quietNavUnloadBlocked(page)).toBe(false); await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
      expect(dialogs).toEqual([]); expect(await quietNavWrites(page)).toEqual([]);
    });
  }

  test(`Quiet hours navigation keeps partial reverts guarded until both saved times are restored at ${width}px`, async ({ page }) => {
    await openQuietNav(page, width); await editQuietNav(page); await quietNavFrom(page).fill('22:00'); await quietNavTo(page).focus();
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    expect(await quietNavUnloadBlocked(page)).toBe(true); await quietNavLeave(page); await expect.poll(() => dialogs).toEqual([quietNavDraftPrompt]);
    await expect(quietNavTo(page)).toBeFocused(); await expect(quietNavTo(page)).toHaveValue('06:15');
    await quietNavTo(page).fill('08:00'); expect(await quietNavUnloadBlocked(page)).toBe(false);
    await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    expect(dialogs).toEqual([quietNavDraftPrompt]); expect(await quietNavWrites(page)).toEqual([]);
  });

  test(`Quiet hours navigation keeps restored times guarded after a failed save until a retry is acknowledged at ${width}px`, async ({ page }) => {
    await openQuietNav(page, width); await editQuietNav(page); await page.evaluate(() => { window.__quietHoursNavigation.failNextSave = true; });
    await activateQuietNav(page, 'window'); await expect(quietNavPanel(page).getByRole('alert')).toHaveText('Quiet hours save failed. Try again.');
    await quietNavFrom(page).fill('22:00'); await quietNavTo(page).fill('08:00');
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.type() === 'beforeunload' ? dialog.type() : dialog.message()); void dialog.dismiss(); });
    expect(await quietNavUnloadBlocked(page)).toBe(true); await page.evaluate(() => { location.reload(); });
    await expect.poll(() => dialogs).toEqual(['beforeunload']); await expect(quietNavTo(page)).toHaveValue('08:00');
    await quietNavLeave(page); await expect.poll(() => dialogs).toEqual(['beforeunload', quietNavDraftPrompt]);
    await activateQuietNav(page, 'window'); await expect(quietNavSave(page)).toBeEnabled(); expect(await quietNavUnloadBlocked(page)).toBe(false);
    await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    expect(dialogs).toEqual(['beforeunload', quietNavDraftPrompt]); expect(await quietNavWrites(page)).toEqual([quietNavWindow, { from_minute: 1320, to_minute: 480 }]);
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`Quiet hours navigation keeps another Settings section focused when a read retry returns ${outcome} at ${width}px`, async ({ page }) => {
      await openQuietNav(page, width, false, true);
      await page.evaluate(outcome => { window.__quietHoursNavigation.failNextRead = outcome === 'error';
        window.__app.holdRpcResponses?.('notification.quiet_hours.get'); }, outcome);
      await quietNavPanel(page).getByRole('button', { name: 'Retry loading quiet hours', exact: true }).press('Enter');
      await expect(quietNavPanel(page).getByRole('status')).toHaveText('Retrying quiet hours…');
      const serverNav = page.locator('[data-recued-settings-nav-item="server"]');
      await serverNav.press('Enter'); await expect(page).toHaveURL(/#settings\/server$/u); await expect(serverNav).toBeFocused();
      expect(await quietNavUnloadBlocked(page)).toBe(false);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('notification.quiet_hours.get'))).toBe(1);
      await expect(quietNavPanel(page)).toHaveAttribute('data-recued-quiet-hours-state', outcome === 'success' ? 'ready' : 'error');
      await expect(page).toHaveURL(/#settings\/server$/u); await expect(serverNav).toBeFocused();
      await expect(quietNavPanel(page)).not.toBeVisible();
      await page.locator('[data-recued-settings-nav-item="notifications"]').click();
      if (outcome === 'success') {
        await expect(quietNavFrom(page)).toHaveValue('22:00'); await expect(quietNavTo(page)).toHaveValue('08:00');
      } else {
        await expect(quietNavPanel(page).getByRole('alert')).toHaveText('Could not read quiet hours.');
        await expect(quietNavPanel(page).getByRole('button', { name: 'Retry loading quiet hours', exact: true })).toBeEnabled();
      }
      expect(await page.evaluate(() => window.__quietHoursNavigation.reads)).toBe(2);
      expect(await quietNavWrites(page)).toEqual([]); expect(await quietNavUnloadBlocked(page)).toBe(false);
    });
  }

  test(`Quiet hours navigation recovers an initial read in place and guards subsequent edits at ${width}px`, async ({ page }) => {
    await openQuietNav(page, width, false, true);
    const retry = quietNavPanel(page).getByRole('button', { name: 'Retry loading quiet hours', exact: true });
    const original = await retry.elementHandle();
    await page.evaluate(() => window.__app.setHash('#settings/server')); await expect(page).toHaveURL(/#settings\/server$/u);
    await page.evaluate(() => window.__app.setHash('#settings/notifications')); await expect(retry).toBeVisible();
    expect(await page.evaluate(() => window.__quietHoursNavigation.reads)).toBe(1);
    await page.evaluate(() => window.__app.holdRpcResponses?.('notification.quiet_hours.get'));
    await retry.focus(); await retry.press('Enter'); await expect(retry).toBeFocused();
    await expect(quietNavPanel(page).getByRole('status')).toHaveText('Retrying quiet hours…');
    await page.keyboard.press('Space'); expect(await page.evaluate(() => window.__quietHoursNavigation.reads)).toBe(2);
    expect(await original!.evaluate(button => button.isConnected && document.activeElement === button)).toBe(true);
    expect(await quietNavUnloadBlocked(page)).toBe(false); expect(await quietNavWrites(page)).toEqual([]);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('notification.quiet_hours.get'))).toBe(1);
    await expect(quietNavFrom(page)).toHaveValue('22:00'); await expect(quietNavTo(page)).toHaveValue('08:00');
    await expect(quietNavFrom(page)).toBeFocused(); await expect(retry).toHaveCount(0);
    await editQuietNav(page);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await quietNavLeave(page); await expect.poll(() => dialogs).toEqual([quietNavDraftPrompt]);
    await expect(quietNavFrom(page)).toHaveValue('23:30'); await expect(quietNavTo(page)).toHaveValue('06:15');
    await activateQuietNav(page, 'window'); await expect(quietNavSave(page)).toBeEnabled();
    expect(await quietNavWrites(page)).toEqual([quietNavWindow]); expect(await quietNavUnloadBlocked(page)).toBe(false);
    await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([quietNavDraftPrompt]);
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`Quiet hours navigation leaves a pending read retry and ignores its late ${outcome} at ${width}px`, async ({ page }) => {
      await openQuietNav(page, width, false, true);
      await page.evaluate(outcome => { window.__quietHoursNavigation.failNextRead = outcome === 'error';
        window.__app.holdRpcResponses?.('notification.quiet_hours.get'); }, outcome);
      await quietNavPanel(page).getByRole('button', { name: 'Retry loading quiet hours', exact: true }).press('Enter');
      await expect(quietNavPanel(page).getByRole('status')).toHaveText('Retrying quiet hours…');
      expect(await quietNavUnloadBlocked(page)).toBe(false);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([]);
      await page.evaluate(() => window.__app.setHash('#settings/notifications'));
      await expect.poll(() => page.evaluate(() => window.__quietHoursNavigation.reads)).toBe(3);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('notification.quiet_hours.get', 1))).toBe(1);
      await expect(quietNavFrom(page)).toHaveValue('22:00'); await quietNavFrom(page).fill('21:45'); await quietNavFrom(page).focus();
      const fresh = await quietNavFrom(page).elementHandle();
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('notification.quiet_hours.get', 0))).toBe(1);
      await expect(quietNavFrom(page)).toHaveValue('21:45'); await expect(quietNavFrom(page)).toBeFocused();
      expect(await fresh!.evaluate(input => input.isConnected && input === document.activeElement)).toBe(true);
      await expect(quietNavPanel(page).getByRole('alert')).toHaveCount(0);
      expect(await quietNavWrites(page)).toEqual([]); expect(await quietNavUnloadBlocked(page)).toBe(true);
    });
  }

  for (const state of ['draft', 'pending save'] as const) {
    test(`Quiet hours navigation preserves Back history through repeated ${state} cancellation at ${width}px`, async ({ page }) => {
      await openQuietNav(page, width);
      await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
      await page.evaluate(() => window.__app.setHash('#settings/notifications'));
      await expect(quietNavFrom(page)).toHaveValue('22:00'); await editQuietNav(page);
      const original = await quietNavFrom(page).elementHandle();
      if (state === 'pending save') {
        await page.evaluate(() => window.__app.holdRpcResponses?.('notification.quiet_hours.set'));
        await activateQuietNav(page, 'window'); await expect(quietNavFrom(page)).toBeDisabled();
      } else await quietNavTo(page).focus();
      const prompt = state === 'draft' ? quietNavDraftPrompt : quietNavWorkPrompt;
      const dialogs: string[] = []; let accept = false;
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
      for (let attempt = 1; attempt <= 2; attempt++) {
        await page.goBack(); await expect.poll(() => dialogs).toHaveLength(attempt);
        await expect(page).toHaveURL(/#settings\/notifications$/u);
        await expect(quietNavFrom(page)).toHaveValue('23:30'); await expect(quietNavTo(page)).toHaveValue('06:15');
        expect(await original!.evaluate(node => node.isConnected)).toBe(true);
        if (state === 'draft') await expect(quietNavTo(page)).toBeFocused();
        else await expect(quietNavPanel(page).getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
      }
      accept = true; await page.goBack(); await expect(page.locator('[data-recued-yours]')).toBeVisible();
      expect(dialogs).toEqual([prompt, prompt, prompt]);
      await page.goForward(); await expect(page).toHaveURL(/#settings\/notifications$/u);
      await expect(quietNavFrom(page)).toHaveValue(state === 'draft' ? '22:00' : '23:30');
      await expect(quietNavTo(page)).toHaveValue(state === 'draft' ? '08:00' : '06:15');
      await expect(quietNavSave(page)).toBeEnabled();
      if (state === 'pending save') {
        expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('notification.quiet_hours.set'))).toBe(1);
        await expect(quietNavFrom(page)).toHaveValue('23:30'); await expect(quietNavSave(page)).toBeEnabled();
      }
      expect(await quietNavWrites(page)).toEqual(state === 'draft' ? [] : [quietNavWindow]);
      expect(await quietNavUnloadBlocked(page)).toBe(false);
    });
  }

  test(`Quiet hours navigation keeps a pending checkbox save through native reload cancellation at ${width}px`, async ({ page }) => {
    await openQuietNav(page, width); const original = await quietNavFrom(page).elementHandle();
    await page.evaluate(() => window.__app.holdRpcResponses?.('notification.quiet_hours.set'));
    await activateQuietNav(page, 'reminders'); await expect(quietNavFrom(page)).toBeDisabled();
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    await page.evaluate(() => { location.reload(); }); await expect.poll(() => dialogs).toEqual(['beforeunload']);
    await expect(quietNavFrom(page)).toBeDisabled();
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    expect(await quietNavWrites(page)).toEqual([{ enabled: false }]);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('notification.quiet_hours.set'))).toBe(1);
    await expect(quietNavSave(page)).toBeEnabled(); await expect(quietNavCheckbox(page, 'reminders')).not.toBeChecked();
    expect(await quietNavUnloadBlocked(page)).toBe(false);
    await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(quietNavFrom(page)).toHaveValue('22:00'); await expect(quietNavTo(page)).toHaveValue('08:00');
    expect(dialogs).toEqual(['beforeunload']);
  });

  test(`Quiet hours navigation leaves an untouched pending read without a prompt at ${width}px`, async ({ page }) => {
    await openQuietNav(page, width, true); await expect(quietNavPanel(page)).toHaveAttribute('data-recued-quiet-hours-state', 'loading');
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    expect(await quietNavUnloadBlocked(page)).toBe(false);
    await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('notification.quiet_hours.get'))).toBe(1);
    await expect(quietNavPanel(page)).toHaveCount(0); expect(dialogs).toEqual([]); expect(await quietNavWrites(page)).toEqual([]);
  });

  test(`Quiet hours navigation retains both time drafts when leaving is declined at ${width}px`, async ({ page }) => {
    await openQuietNav(page, width); await editQuietNav(page); await quietNavTo(page).focus();
    const originalFrom = await quietNavFrom(page).elementHandle(), originalTo = await quietNavTo(page).elementHandle();
    const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    expect(await quietNavUnloadBlocked(page)).toBe(true);
    await quietNavLeave(page); await expect.poll(() => dialogs).toEqual([quietNavDraftPrompt]);
    await expect(page).toHaveURL(/#settings\/notifications$/u); await expect(quietNavTo(page)).toBeFocused();
    await expect(quietNavFrom(page)).toHaveValue('23:30'); await expect(quietNavTo(page)).toHaveValue('06:15');
    expect(await originalFrom!.evaluate(node => node.isConnected)).toBe(true);
    expect(await originalTo!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
    accept = true; await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    expect(dialogs).toEqual([quietNavDraftPrompt, quietNavDraftPrompt]);
    await page.evaluate(() => window.__app.setHash('#settings/notifications'));
    await expect(quietNavFrom(page)).toHaveValue('22:00'); await expect(quietNavTo(page)).toHaveValue('08:00');
    expect(await quietNavWrites(page)).toEqual([]);
  });

  test(`Quiet hours navigation allows untouched and saved windows without a prompt at ${width}px`, async ({ page }) => {
    await openQuietNav(page, width);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    expect(await quietNavUnloadBlocked(page)).toBe(false);
    await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#settings/notifications')); await expect(quietNavFrom(page)).toHaveValue('22:00');
    await editQuietNav(page); await activateQuietNav(page, 'window'); await expect(quietNavSave(page)).toBeEnabled();
    expect(await quietNavWrites(page)).toEqual([quietNavWindow]); expect(await quietNavUnloadBlocked(page)).toBe(false);
    await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([]);
  });

  for (const kind of ['window', 'reminders', 'approvals'] as const) {
    test(`Quiet hours navigation guards a pending ${kind} save at ${width}px`, async ({ page }) => {
      await openQuietNav(page, width); if (kind === 'window') await editQuietNav(page);
      const original = await quietNavFrom(page).elementHandle();
      await page.evaluate(() => window.__app.holdRpcResponses?.('notification.quiet_hours.set'));
      await activateQuietNav(page, kind); await expect(quietNavFrom(page)).toBeDisabled();
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      expect(await quietNavUnloadBlocked(page)).toBe(true);
      await quietNavLeave(page); await expect.poll(() => dialogs).toEqual([quietNavWorkPrompt]);
      await expect(page).toHaveURL(/#settings\/notifications$/u); await expect(quietNavFrom(page)).toBeDisabled();
      expect(await original!.evaluate(node => node.isConnected)).toBe(true);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('notification.quiet_hours.set'))).toBe(1);
      await expect(quietNavSave(page)).toBeEnabled();
      expect(await quietNavWrites(page)).toEqual([kind === 'window' ? quietNavWindow
        : kind === 'reminders' ? { enabled: false } : { applies_to: ['notification', 'approval'] }]);
      expect(await quietNavUnloadBlocked(page)).toBe(false);
      await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([quietNavWorkPrompt]);
    });
  }

  for (const kind of ['reminders', 'approvals'] as const) {
    test(`Quiet hours navigation retains the time draft after a ${kind} acknowledgement at ${width}px`, async ({ page }) => {
      await openQuietNav(page, width); await editQuietNav(page); await activateQuietNav(page, kind);
      await expect(quietNavSave(page)).toBeEnabled();
      await expect(quietNavCheckbox(page, kind)).toBeChecked({ checked: kind === 'approvals' });
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await quietNavLeave(page); await expect.poll(() => dialogs).toEqual([quietNavDraftPrompt]);
      await expect(quietNavFrom(page)).toHaveValue('23:30'); await expect(quietNavTo(page)).toHaveValue('06:15');
      await activateQuietNav(page, 'window'); await expect(quietNavSave(page)).toBeEnabled();
      expect(await quietNavWrites(page)).toEqual([kind === 'reminders' ? { enabled: false } : { applies_to: ['notification', 'approval'] }, quietNavWindow]);
      await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([quietNavDraftPrompt]);
    });
  }

  test(`Quiet hours navigation retains a refused window until its retry succeeds at ${width}px`, async ({ page }) => {
    await openQuietNav(page, width); await editQuietNav(page);
    await page.evaluate(() => { window.__quietHoursNavigation.failNextSave = true; });
    await activateQuietNav(page, 'window'); await expect(quietNavPanel(page).getByRole('alert')).toHaveText('Quiet hours save failed. Try again.');
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await quietNavLeave(page); await expect.poll(() => dialogs).toEqual([quietNavDraftPrompt]);
    await expect(quietNavFrom(page)).toHaveValue('23:30'); await expect(quietNavTo(page)).toHaveValue('06:15');
    await activateQuietNav(page, 'window'); await expect(quietNavSave(page)).toBeEnabled();
    await expect(quietNavPanel(page).getByRole('alert')).toHaveCount(0); expect(await quietNavWrites(page)).toEqual([quietNavWindow, quietNavWindow]);
    await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([quietNavDraftPrompt]);
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`Quiet hours navigation ignores a late ${outcome} save reply after an accepted leave at ${width}px`, async ({ page }) => {
      await openQuietNav(page, width); await editQuietNav(page); const original = await quietNavFrom(page).elementHandle();
      await page.evaluate(outcome => { window.__quietHoursNavigation.failNextSave = outcome === 'error';
        window.__app.holdRpcResponses?.('notification.quiet_hours.set'); }, outcome);
      await activateQuietNav(page, 'window'); await expect(quietNavFrom(page)).toBeDisabled();
      const dialogs: string[] = []; let accept = true;
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
      await quietNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([quietNavWorkPrompt]);
      expect(await original!.evaluate(node => node.isConnected)).toBe(false);
      await page.evaluate(() => window.__app.setHash('#settings/notifications'));
      await expect(quietNavPanel(page)).toHaveAttribute('data-recued-quiet-hours-state', 'ready');
      await quietNavFrom(page).fill('21:45'); await quietNavFrom(page).focus(); const fresh = await quietNavFrom(page).elementHandle();
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('notification.quiet_hours.set'))).toBe(1);
      await expect(quietNavFrom(page)).toHaveValue('21:45'); await expect(quietNavFrom(page)).toBeFocused();
      expect(await fresh!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      await expect(quietNavPanel(page).getByRole('alert')).toHaveCount(0);
      accept = false; await quietNavLeave(page); await expect.poll(() => dialogs).toEqual([quietNavWorkPrompt, quietNavDraftPrompt]);
      await expect(quietNavFrom(page)).toHaveValue('21:45');
    });
  }

  for (const [which, segment, index, typed, expected] of [
    ['from', 'hour', 0, '10', '10:30'], ['to', 'minute', 1, '45', '09:45'],
  ] as const) {
    test(`Quiet hours navigation preserves the incomplete ${which} ${segment} after cancellation at ${width}px`, async ({ page }) => {
      await openQuietNav(page, width); const field = which === 'from' ? quietNavFrom(page) : quietNavTo(page);
      const selectSegment = async () => { await field.focus(); for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft');
        for (let step = 0; step < index; step++) await page.keyboard.press('ArrowRight'); };
      await field.fill('09:30'); await selectSegment(); await page.keyboard.press('Backspace');
      expect(await field.evaluate((input: HTMLInputElement) => input.validity.badInput && input.value === '')).toBe(true);
      const original = await field.elementHandle();
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await quietNavLeave(page); await expect.poll(() => dialogs).toEqual([quietNavDraftPrompt]); await expect(field).toBeFocused();
      expect(await original!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      expect(await field.evaluate((input: HTMLInputElement) => input.validity.badInput && input.value === '')).toBe(true);
      await selectSegment(); await page.keyboard.type(typed); await expect(field).toHaveValue(expected);
      await expect(which === 'from' ? quietNavTo(page) : quietNavFrom(page)).toHaveValue(which === 'from' ? '08:00' : '22:00');
      expect(await quietNavWrites(page)).toEqual([]);
    });
  }

  test(`Quiet hours navigation guards the timezone link when the window has edits at ${width}px`, async ({ page }) => {
    await openQuietNav(page, width); await editQuietNav(page);
    const link = quietNavPanel(page).locator('[data-recued-quiet-hours-timezone-link]');
    await expect(link).toHaveAttribute('href', '#settings/server/timezone');
    const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    await link.press('Enter'); await expect.poll(() => dialogs).toEqual([quietNavDraftPrompt]);
    await expect(page).toHaveURL(/#settings\/notifications$/u); await expect(link).toBeFocused();
    await expect(quietNavFrom(page)).toHaveValue('23:30'); await expect(quietNavTo(page)).toHaveValue('06:15');
    accept = true; await link.press('Enter'); await expect(page.getByRole('tab', { name: 'Timezone', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-recued-server-timezone-panel]')).toBeVisible();
    expect(dialogs).toEqual([quietNavDraftPrompt, quietNavDraftPrompt]); expect(await quietNavWrites(page)).toEqual([]);
  });

  test(`Quiet hours navigation protects time edits through native reload cancellation at ${width}px`, async ({ page }) => {
    await openQuietNav(page, width); await editQuietNav(page); const original = await quietNavFrom(page).elementHandle();
    const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.type()); void (accept ? dialog.accept() : dialog.dismiss()); });
    await page.evaluate(() => { location.reload(); }); await expect.poll(() => dialogs).toEqual(['beforeunload']);
    await expect(quietNavFrom(page)).toHaveValue('23:30'); await expect(quietNavTo(page)).toHaveValue('06:15');
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    accept = true; await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(quietNavFrom(page)).toHaveValue('22:00'); await expect(quietNavTo(page)).toHaveValue('08:00');
    expect(dialogs).toEqual(['beforeunload', 'beforeunload']);
  });
}

declare global { interface Window {
  __timezoneNavigation: { reads: number; writes: ServerTimeZoneSetRequest[]; failNextSave: boolean; loseNextSaveReply: boolean; failNextRead: boolean };
} }
const tzNavPanel = (page: Page) => page.locator('[data-recued-server-timezone-panel]');
const tzNavZone = (page: Page) => tzNavPanel(page).getByRole('textbox', { name: 'Server timezone', exact: true });
const tzNavSave = (page: Page) => tzNavPanel(page).getByRole('button', { name: 'Save', exact: true });
const tzNavMode = (page: Page, mode: 'fixed' | 'follows_host') => tzNavPanel(page).locator(`[data-recued-server-timezone-mode="${mode}"]`);
const tzNavDraftPrompt = 'Discard the unsaved server timezone?';
const tzNavWorkPrompt = 'The server timezone is still updating. Leave Settings anyway?';
const tzNavWrites = (page: Page) => page.evaluate(() => window.__timezoneNavigation.writes);
const tzNavLeave = (page: Page) => page.evaluate(() => window.__app.setHash('#yours/assets'));
const tzNavUnloadBlocked = (page: Page) => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
});
const openTimezoneNav = async (page: Page, width: number, mode: 'fixed' | 'follows_host' = 'fixed', holdRead = false) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(mode => {
    let current: ServerTimeZoneGetResponse = { setting: { mode, zone: mode === 'fixed' ? 'Europe/London' : null, updated_at: 1 },
      resolved_zone: 'Europe/London', host_zone: 'Europe/London' };
    const controls = { reads: 0, writes: [] as ServerTimeZoneSetRequest[], failNextSave: false, loseNextSaveReply: false, failNextRead: false }; window.__timezoneNavigation = controls;
    Object.assign(window, { __connectionsFixture: async (method: string, args: unknown) => {
      if (method === 'server.timezone.get') {
        controls.reads++;
        if (controls.failNextRead) { controls.failNextRead = false; return { error: { code: 'unavailable', message: 'Timezone check failed. Try again.' } }; }
        return { result: structuredClone(current) };
      }
      if (method === 'server.timezone.set') {
        const patch = args as ServerTimeZoneSetRequest; controls.writes.push(structuredClone(patch));
        if (controls.failNextSave) { controls.failNextSave = false; return { error: { code: 'unavailable', message: 'Timezone save failed. Try again.' } }; }
        const zone = patch.zone === undefined ? current.setting.zone : patch.zone;
        current = { ...current, setting: { mode: patch.mode, zone, updated_at: current.setting.updated_at + 1 },
          resolved_zone: patch.mode === 'fixed' ? zone! : current.host_zone };
        if (controls.loseNextSaveReply) { controls.loseNextSaveReply = false; return { error: { code: 'unavailable', message: 'Timezone save failed. Try again.' } }; }
        return { result: structuredClone(current) };
      }
      return undefined;
    } });
  }, mode);
  await page.goto(`${HARNESS_URL}?yours=demo&notifications=ready${holdRead ? '&hold_rpc=server.timezone.get' : ''}#settings/server/timezone`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (!holdRead) { await expect(tzNavPanel(page)).toHaveAttribute('data-recued-server-timezone-state', 'ready'); await expect(tzNavMode(page, mode)).toBeChecked(); }
};

for (const width of [390, 1280]) {
  test(`Server timezone navigation keeps a zone draft and selection when departure is declined at ${width}px`, async ({ page }) => {
    await openTimezoneNav(page, width); await tzNavZone(page).fill('  Asia/Tokyo  ');
    await tzNavZone(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(3, 8, 'backward'));
    const original = await tzNavZone(page).elementHandle(), dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    expect(await tzNavUnloadBlocked(page)).toBe(true); await tzNavLeave(page); await expect.poll(() => dialogs).toEqual([tzNavDraftPrompt]);
    await expect(page).toHaveURL(/#settings\/server\/timezone$/u); await expect(tzNavZone(page)).toHaveValue('  Asia/Tokyo  '); await expect(tzNavZone(page)).toBeFocused();
    expect(await tzNavZone(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([3, 8, 'backward']);
    expect(await original!.evaluate(input => input.isConnected && input === document.activeElement)).toBe(true);
    accept = true; await tzNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#settings/server/timezone')); await expect(tzNavZone(page)).toHaveValue('Europe/London');
    expect(dialogs).toEqual([tzNavDraftPrompt, tzNavDraftPrompt]); expect(await tzNavWrites(page)).toEqual([]);
  });

  test(`Server timezone navigation protects raw text through canceled and accepted native reloads at ${width}px`, async ({ page }) => {
    await openTimezoneNav(page, width); await tzNavZone(page).fill('Asia/Tokyo'); const original = await tzNavZone(page).elementHandle();
    const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.type()); void (accept ? dialog.accept() : dialog.dismiss()); });
    await page.evaluate(() => { location.reload(); }); await expect.poll(() => dialogs).toEqual(['beforeunload']);
    await expect(tzNavZone(page)).toHaveValue('Asia/Tokyo'); expect(await original!.evaluate(input => input.isConnected)).toBe(true);
    accept = true; await page.reload(); await page.waitForFunction(() => window.__app?.ready === true); await expect(tzNavZone(page)).toHaveValue('Europe/London');
    expect(dialogs).toEqual(['beforeunload', 'beforeunload']); expect(await tzNavWrites(page)).toEqual([]);
  });

  test(`Server timezone navigation protects an unsaved fixed-mode choice and clears it only after Save at ${width}px`, async ({ page }) => {
    await openTimezoneNav(page, width, 'follows_host'); await tzNavMode(page, 'fixed').press('Space');
    await expect(tzNavZone(page)).toHaveValue(''); await expect(tzNavZone(page)).toBeFocused(); expect(await tzNavUnloadBlocked(page)).toBe(true);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await tzNavLeave(page); await expect.poll(() => dialogs).toEqual([tzNavDraftPrompt]); await expect(tzNavMode(page, 'fixed')).toBeChecked();
    await tzNavZone(page).fill('Asia/Tokyo'); expect(await tzNavWrites(page)).toEqual([]); await tzNavZone(page).press('Enter');
    await expect(tzNavPanel(page).getByText('Saved as Asia/Tokyo.', { exact: true })).toBeVisible(); expect(await tzNavUnloadBlocked(page)).toBe(false);
    await tzNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    expect(dialogs).toEqual([tzNavDraftPrompt]); expect(await tzNavWrites(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }]);
  });

  test(`Server timezone navigation allows untouched and fully restored values without a warning at ${width}px`, async ({ page }) => {
    await openTimezoneNav(page, width); expect(await tzNavUnloadBlocked(page)).toBe(false);
    await tzNavZone(page).fill('Asia/Tokyo'); expect(await tzNavUnloadBlocked(page)).toBe(true);
    await tzNavZone(page).fill('Europe/London'); expect(await tzNavUnloadBlocked(page)).toBe(false);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await tzNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([]); expect(await tzNavWrites(page)).toEqual([]);
  });
}

for (const width of [390, 1280]) {
  for (const kind of ['fixed', 'follows_host'] as const) {
    test(`Server timezone navigation guards a pending ${kind} save until its reply at ${width}px`, async ({ page }) => {
      await openTimezoneNav(page, width); await page.evaluate(() => window.__app.holdRpcResponses?.('server.timezone.set'));
      if (kind === 'fixed') { await tzNavZone(page).fill('Asia/Tokyo'); await tzNavSave(page).press('Enter'); }
      else await tzNavMode(page, 'follows_host').press('Space');
      const original = await tzNavZone(page).elementHandle(); await expect(tzNavZone(page)).toBeDisabled();
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      expect(await tzNavUnloadBlocked(page)).toBe(true); await tzNavLeave(page); await expect.poll(() => dialogs).toEqual([tzNavWorkPrompt]);
      await expect(page).toHaveURL(/#settings\/server\/timezone$/u); await expect(tzNavPanel(page).getByRole('status').filter({ hasText: 'Saving timezone…' })).toBeFocused();
      expect(await original!.evaluate(input => input.isConnected)).toBe(true);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('server.timezone.set'))).toBe(1);
      await expect(tzNavMode(page, kind)).toBeEnabled(); await expect(tzNavMode(page, kind)).toBeChecked(); expect(await tzNavUnloadBlocked(page)).toBe(false);
      await tzNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
      expect(dialogs).toEqual([tzNavWorkPrompt]); expect(await tzNavWrites(page)).toEqual([kind === 'fixed' ? { mode: 'fixed', zone: 'Asia/Tokyo' } : { mode: 'follows_host' }]);
    });

    test(`Server timezone navigation ignores a late ${kind} acknowledgement after accepted departure at ${width}px`, async ({ page }) => {
      await openTimezoneNav(page, width); await page.evaluate(() => window.__app.holdRpcResponses?.('server.timezone.set'));
      if (kind === 'fixed') { await tzNavZone(page).fill('Asia/Tokyo'); await tzNavSave(page).press('Enter'); }
      else await tzNavMode(page, 'follows_host').press('Space');
      const original = await tzNavPanel(page).elementHandle(), dialogs: string[] = []; let accept = true;
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
      await tzNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([tzNavWorkPrompt]);
      expect(await original!.evaluate(panel => panel.isConnected)).toBe(false);
      await page.evaluate(() => window.__app.setHash('#settings/server/timezone')); await expect(tzNavMode(page, kind)).toBeChecked();
      if (kind === 'follows_host') await tzNavMode(page, 'fixed').press('Space');
      await tzNavZone(page).fill('Pacific/Auckland'); await tzNavZone(page).focus(); const fresh = await tzNavZone(page).elementHandle();
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('server.timezone.set'))).toBe(1);
      await expect(tzNavZone(page)).toHaveValue('Pacific/Auckland'); await expect(tzNavZone(page)).toBeFocused();
      expect(await fresh!.evaluate(input => input.isConnected && input === document.activeElement)).toBe(true);
      accept = false; await tzNavLeave(page); await expect.poll(() => dialogs).toEqual([tzNavWorkPrompt, tzNavDraftPrompt]);
      expect(await tzNavWrites(page)).toHaveLength(1);
    });
  }

  test(`Server timezone navigation retains uncertainty after restoring a failed save until retry succeeds at ${width}px`, async ({ page }) => {
    await openTimezoneNav(page, width); await tzNavZone(page).fill('Asia/Tokyo'); await page.evaluate(() => { window.__timezoneNavigation.failNextSave = true; });
    await tzNavSave(page).press('Enter'); await expect(tzNavPanel(page).getByRole('alert')).toHaveText('Timezone save failed. Try again.');
    await tzNavZone(page).fill('Europe/London'); expect(await tzNavUnloadBlocked(page)).toBe(true);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await tzNavLeave(page); await expect.poll(() => dialogs).toEqual([tzNavDraftPrompt]); await tzNavSave(page).press('Enter');
    await expect(tzNavSave(page)).toBeEnabled(); expect(await tzNavUnloadBlocked(page)).toBe(false);
    await tzNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    expect(dialogs).toEqual([tzNavDraftPrompt]); expect(await tzNavWrites(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }, { mode: 'fixed', zone: 'Europe/London' }]);
  });

  test(`Server timezone navigation preserves Back and Forward through repeated draft cancellation at ${width}px`, async ({ page }) => {
    await openTimezoneNav(page, width); await tzNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.evaluate(() => window.__app.setHash('#settings/server/timezone')); await expect(tzNavZone(page)).toHaveValue('Europe/London');
    await tzNavZone(page).fill('Asia/Tokyo'); const original = await tzNavZone(page).elementHandle();
    const dialogs: string[] = []; let accept = false;
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await page.goBack(); await expect.poll(() => dialogs).toHaveLength(attempt); await expect(page).toHaveURL(/#settings\/server\/timezone$/u);
      await expect(tzNavZone(page)).toHaveValue('Asia/Tokyo'); expect(await original!.evaluate(input => input.isConnected)).toBe(true);
    }
    accept = true; await page.goBack(); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    await page.goForward(); await expect(tzNavZone(page)).toHaveValue('Europe/London');
    expect(dialogs).toEqual([tzNavDraftPrompt, tzNavDraftPrompt, tzNavDraftPrompt]); expect(await tzNavWrites(page)).toEqual([]);
  });

  test(`Server timezone navigation leaves untouched initial reads and ignores their late replies at ${width}px`, async ({ page }) => {
    await openTimezoneNav(page, width, 'fixed', true); await expect(tzNavPanel(page)).toHaveAttribute('data-recued-server-timezone-state', 'loading');
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    expect(await tzNavUnloadBlocked(page)).toBe(false); await tzNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    const readCount = await page.evaluate(() => window.__timezoneNavigation.reads);
    expect(readCount).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('server.timezone.get'))).toBe(readCount);
    await expect(tzNavPanel(page)).toHaveCount(0); expect(dialogs).toEqual([]); expect(await tzNavWrites(page)).toEqual([]);
  });
}

test('Settings Backup & Recovery hands focus into and back from each entry flow', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/backup'));

  const backupSection = page.locator(
    '[data-recued-settings-section="backup"]',
  );
  await expect(backupSection.getByRole('heading', {
    name: 'Backup & Recovery',
    exact: true,
  })).toHaveCount(1);

  const backup = page.locator(`[${ARCHIVE_BACKUP_START}]`);
  await backup.focus();
  await page.keyboard.press('Enter');
  const backupKey = page.getByRole('textbox', {
    name: '24-word recovery key',
  });
  await expect(backupKey).toHaveAttribute(ARCHIVE_BACKUP_MNEMONIC, '');
  await expect(backupKey).toBeFocused();

  let cancel = page.locator(`[${ARCHIVE_BACKUP_CANCEL}]`);
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(backup).toBeFocused();

  const restore = page.locator(`[${ARCHIVE_RESTORE_START}]`);
  await restore.focus();
  await page.keyboard.press('Enter');
  const restoreEntry = page.locator(
    `[${ARCHIVE_RESTORE_UPLOAD_INPUT}], [${ARCHIVE_RESTORE_PATH}]`,
  ).first();
  await expect(restoreEntry).toBeFocused();
  await expect(page.getByLabel('Upload a backup file from this device'))
    .toHaveAttribute(ARCHIVE_RESTORE_UPLOAD_INPUT, '');
  await expect(page.getByRole('textbox', {
    name: 'Or where to find one already on your server',
  })).toHaveAttribute(ARCHIVE_RESTORE_PATH, '');
  await expect(page.getByRole('textbox', {
    name: 'Recovery key for this backup',
  })).toHaveAttribute(ARCHIVE_RESTORE_MNEMONIC, '');

  cancel = page.locator(`[${ARCHIVE_BACKUP_CANCEL}]`);
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(restore).toBeFocused();
});

test('Settings Backup keeps a keyboard-owned export on its live progress', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
  await page.locator(`[${ARCHIVE_BACKUP_START}]`).click();
  await page.locator(`[${ARCHIVE_BACKUP_MNEMONIC}]`).fill(
    `${'abandon '.repeat(23)}art`,
  );

  const run = page.locator(`[${ARCHIVE_BACKUP_RUN}]`);
  await run.focus();
  await page.keyboard.press('Enter');

  const progress = page.locator(`[${ARCHIVE_BACKUP_PROGRESS}]`);
  await expect(progress).toHaveAttribute('role', 'progressbar');
  await expect(progress).toHaveAttribute('tabindex', '-1');
  await expect(progress).toBeFocused();
});

test('Settings Restore keeps a keyboard-owned preview on its busy status', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
  await page.locator(`[${ARCHIVE_RESTORE_START}]`).click();
  await page.locator(`[${ARCHIVE_RESTORE_PATH}]`).fill(
    'exports/recued-2026-06-25.recued.archive',
  );
  await page.locator(`[${ARCHIVE_RESTORE_MNEMONIC}]`).fill(
    `${'abandon '.repeat(23)}art`,
  );

  const preview = page.locator(`[${ARCHIVE_RESTORE_PREVIEW}]`);
  await preview.focus();
  await page.keyboard.press('Enter');

  const busy = page.locator(`[${ARCHIVE_BACKUP_BUSY}]`);
  await expect(busy).toHaveText('Reading the backup…');
  await expect(busy).toHaveAttribute('tabindex', '-1');
  await expect(busy).toBeFocused();
});

test('Settings Restore keeps its destructive arm focused through confirmation', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?archive=restore-preview`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
  await page.locator(`[${ARCHIVE_RESTORE_START}]`).click();
  await page.locator(`[${ARCHIVE_RESTORE_PATH}]`).fill(
    'exports/recued-2026-06-25.recued.archive',
  );
  await page.locator(`[${ARCHIVE_RESTORE_MNEMONIC}]`).fill(
    `${'abandon '.repeat(23)}art`,
  );
  await page.locator(`[${ARCHIVE_RESTORE_PREVIEW}]`).click();

  const arm = page.locator(`[${ARCHIVE_RESTORE_ARM}]`);
  await expect(arm).toBeVisible();
  await arm.focus();
  await page.keyboard.press('Space');

  await expect(arm).toBeChecked();
  await expect(arm).toBeFocused();
});

test('Settings Restore keeps a keyboard-owned commit on truthful live status', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?archive=restore-preview`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
  await page.locator(`[${ARCHIVE_RESTORE_START}]`).click();
  await page.locator(`[${ARCHIVE_RESTORE_PATH}]`).fill(
    'exports/recued-2026-06-25.recued.archive',
  );
  await page.locator(`[${ARCHIVE_RESTORE_MNEMONIC}]`).fill(
    `${'abandon '.repeat(23)}art`,
  );
  await page.locator(`[${ARCHIVE_RESTORE_PREVIEW}]`).click();
  await page.locator(`[${ARCHIVE_RESTORE_ARM}]`).check();

  const commit = page.locator(`[${ARCHIVE_RESTORE_COMMIT}]`);
  await commit.focus();
  await page.keyboard.press('Enter');

  const busy = page.locator(`[${ARCHIVE_BACKUP_BUSY}]`);
  await expect(busy).toHaveText('Putting the backup back…');
  await expect(busy).toHaveAttribute('tabindex', '-1');
  await expect(busy).toBeFocused();
});

test('Settings Passport keeps its keyboard-owned export on live status', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/backup'));

  const start = page.locator(`[${ARCHIVE_PASSPORT_START}]`);
  await start.focus();
  await page.keyboard.press('Enter');

  const busy = page.locator(`[${ARCHIVE_BACKUP_BUSY}]`);
  await expect(busy).toHaveText('Saving this server’s identity…');
  await expect(busy).toHaveAttribute('tabindex', '-1');
  await expect(busy).toBeFocused();
});

test('Settings Transparency retains its pending preference on route leave', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const toggle = page.locator(
    `[${TRANSPARENCY_TOGGLE}="ui.transparency.class.orchestration"]`,
  );
  await expect(toggle).not.toBeChecked();
  const writesBefore = await page.evaluate(
    () => window.__app.rpcCallCount('prefs.set'),
  );
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
  });

  await toggle.focus();
  await page.keyboard.press('Space');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('prefs.set')),
  ).toBe(writesBefore + 1);
  await page.evaluate(() => window.__app.setHash('#chat'));

  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A transparency setting is still updating. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/privacy$/);
  await expect(toggle).toBeChecked();
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).not.toHaveAttribute('disabled');
  await expect(toggle).toBeFocused();
  await toggle.evaluate((checkbox: HTMLElement) => {
    checkbox.click();
    checkbox.click();
  });
  await expect(toggle).toBeChecked();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('prefs.set')),
  ).toBe(writesBefore + 1);
});

test('Settings Privacy gives every mobile checkbox a full label target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?privacy=learning-cases-multiple`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const section = page.locator('[data-recued-settings-section="privacy"]');
  const targets = section.locator('label:has(input[type="checkbox"])');
  const heights = await targets.evaluateAll((labels) => labels.map(
    (label) => label.getBoundingClientRect().height,
  ));
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(36);
  expect(await section.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test('Settings Learning keeps its pending preference truthful, focused, and single-flight', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const toggle = page.locator(`[${LEARNING_TOGGLE}]`);
  const initiallyChecked = await toggle.isChecked();
  const writesBefore = await page.evaluate(
    () => window.__app.rpcCallCount('prefs.set'),
  );

  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked({ checked: !initiallyChecked });
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).not.toHaveAttribute('disabled');
  await expect(toggle).toBeFocused();

  await toggle.evaluate((checkbox: HTMLElement) => {
    checkbox.click();
    checkbox.click();
  });
  await expect(toggle).toBeChecked({ checked: !initiallyChecked });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('prefs.set')),
  ).toBe(writesBefore + 1);
});

test('Settings Learning identifies repeated case actions by their owning case', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?privacy=learning-cases-multiple`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const firstDraft = page.locator(`[${LEARNING_DRAFT}="learning-case-1"]`);
  const secondDraft = page.locator(`[${LEARNING_DRAFT}="learning-case-2"]`);
  await expect(firstDraft).toHaveAccessibleName(
    'Make a Recipe from what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(secondDraft).toHaveAccessibleName(
    'Make a Recipe from what it learned: schedule the weekly inventory digest (learning-case-2)',
  );
  await expect(page.locator(`[${LEARNING_FORGET}="learning-case-1"]`))
    .toHaveAccessibleName(
      'Forget what it learned: send the quarterly report (learning-case-1)',
    );
  await expect(page.locator(`[${LEARNING_FORGET}="learning-case-2"]`))
    .toHaveAccessibleName(
      'Forget what it learned: schedule the weekly inventory digest (learning-case-2)',
    );
  const actionHeights = await page
    .locator(`[${LEARNING_DRAFT}], [${LEARNING_FORGET}]`)
    .evaluateAll((actions) =>
      actions.map((action) => action.getBoundingClientRect().height)
    );
  expect(Math.min(...actionHeights)).toBeGreaterThanOrEqual(36);
});

test('Settings Learning owns a keyboard Forget through confirmation and removal', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?privacy=learning-cases&learning_forget_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const forget = page.locator(`[${LEARNING_FORGET}="learning-case-1"]`);
  await expect(forget).toHaveText('Forget');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
  });
  await forget.focus();
  await page.keyboard.press('Enter');

  await expect(forget).toHaveText('Tap again to forget');
  await expect(forget).toHaveAccessibleName(
    'Confirm forgetting what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(forget).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(forget).toHaveText('Forgetting...');
  await expect(forget).toHaveAccessibleName(
    'Forgetting what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(forget).toHaveAttribute('aria-disabled', 'true');
  await expect(forget).toHaveAttribute('aria-busy', 'true');
  await expect(forget).not.toHaveAttribute('disabled');
  await expect(forget).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A learning change is still updating. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/privacy$/);
  const competingDraft = page.locator(
    `[${LEARNING_DRAFT}="learning-case-1"]`,
  );
  await expect(competingDraft).toHaveAttribute('aria-disabled', 'true');
  await expect(competingDraft).not.toHaveAttribute('disabled');
  await competingDraft.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.draft_recipe'),
    ),
  ).toBe(0);
  await forget.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.forget'),
    ),
  ).toBe(1);

  const empty = page.locator(`[${LEARNING_CASES_EMPTY}]`);
  await expect(empty).toBeVisible();
  await expect(empty).toHaveAttribute('tabindex', '-1');
  await expect(empty).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings Learning keeps a failed Forget beside its focused case', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?privacy=learning-cases&learning_forget_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const forget = page.locator(`[${LEARNING_FORGET}="learning-case-1"]`);
  await forget.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(forget).toHaveText('Forgetting...');

  await expect(page.locator(`[${LEARNING_FORGET_ERROR}]`)).toContainText(
    'Learning history is temporarily unavailable.',
  );
  await expect(page.locator(`[${LEARNING_CASE}="learning-case-1"]`))
    .toBeVisible();
  await expect(page.locator(`[${LEARNING_CASES_ERROR}]`)).toHaveCount(0);
  await expect(forget).toHaveText('Tap again to forget');
  await expect(forget).toHaveAccessibleName(
    'Confirm forgetting what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(forget).toBeFocused();
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.forget'),
    ),
  ).toBe(1);
});

test('Settings Learning retains a keyboard-owned recipe draft through failure', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?privacy=learning-cases&learning_draft_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const draft = page.locator(`[${LEARNING_DRAFT}="learning-case-1"]`);
  await draft.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`[${LEARNING_DRAFT_CONFIRM}]`)).toBeVisible();
  await expect(draft).toHaveText('Yes, write the draft');
  await expect(draft).toHaveAccessibleName(
    'Say yes to the Recipe from what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(draft).toBeFocused();

  const prompt = page.locator(`[${LEARNING_DRAFT_PROMPT}]`);
  await expect(prompt).toHaveAccessibleName(
    'What the Recipe should do, for what it learned: send the quarterly report (learning-case-1)',
  );
  await prompt.fill('Run it every Monday');
  await draft.focus();
  await page.keyboard.press('Enter');

  await expect(draft).toHaveText('Asking your AI…');
  await expect(draft).toHaveAccessibleName(
    'Asking your AI to write a Recipe from what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(draft).toHaveAttribute('aria-disabled', 'true');
  await expect(draft).toHaveAttribute('aria-busy', 'true');
  await expect(draft).not.toHaveAttribute('disabled');
  await expect(draft).toBeFocused();
  await expect(prompt).toHaveValue('Run it every Monday');
  const competingForget = page.locator(
    `[${LEARNING_FORGET}="learning-case-1"]`,
  );
  await expect(competingForget).toHaveAttribute('aria-disabled', 'true');
  await expect(competingForget).not.toHaveAttribute('disabled');
  await competingForget.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.forget'),
    ),
  ).toBe(0);
  await draft.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.draft_recipe'),
    ),
  ).toBe(1);

  await expect(page.locator(`[${LEARNING_DRAFT_ERROR}]`)).toContainText(
    'Recipe drafting is temporarily unavailable.',
  );
  await expect(draft).toHaveText('Yes, write the draft');
  await expect(draft).toHaveAccessibleName(
    'Say yes to the Recipe from what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(draft).toBeFocused();
  await expect(prompt).toHaveValue('Run it every Monday');
});

test('Settings Learning retries a finished draft handoff without asking AI again', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?privacy=learning-cases&learning_draft_handoff=fail-once`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const draft = page.locator(`[${LEARNING_DRAFT}="learning-case-1"]`);
  await draft.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  await expect(page.locator(`[${LEARNING_DRAFT_ERROR}]`)).toContainText(
    'finished draft',
  );
  await expect(draft).toHaveText('Open finished draft');
  await expect(draft).toHaveAccessibleName(
    'Open finished draft from what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(draft).toBeFocused();
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.draft_recipe'),
    ),
  ).toBe(1);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    window.__app.setHash('#chat');
  });
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Discard the finished recipe draft?',
  );
  await expect(page).toHaveURL(/#settings\/privacy$/);

  await page.keyboard.press('Enter');
  await expect(page.locator(`[${LEARNING_DRAFT_ROUTE}]`)).toBeVisible();
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.draft_recipe'),
    ),
  ).toBe(1);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings Privacy owns the Clear-this-browser safety confirmation', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const clear = page.locator(`[${CLEAR_THIS_BROWSER_CLEAR}]`);
  await clear.focus();
  await page.keyboard.press('Enter');

  const cancel = page.locator(`[${CLEAR_THIS_BROWSER_CANCEL}]`);
  await expect(page.locator(`[${CLEAR_THIS_BROWSER_CONFIRM}]`)).toBeVisible();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(clear).toBeVisible();
  await expect(clear).toBeFocused();
});

test('Settings Privacy owns browser clearing through live completion', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?browser_clear=slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  await page.locator(`[${CLEAR_THIS_BROWSER_CLEAR}]`).click();
  const confirm = page.locator(`[${CLEAR_THIS_BROWSER_CONFIRM}]`);
  await confirm.focus();
  await page.keyboard.press('Enter');

  const status = page.locator(`[${CLEAR_THIS_BROWSER_STATUS}]`);
  await expect(status).toHaveText('Clearing…');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveAttribute('tabindex', '-1');
  await expect(status).toBeFocused();

  await expect(status).toContainText('Load the page again to pair');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toBeFocused();
  await expect(page.locator(`[${CLEAR_THIS_BROWSER_RELOAD}]`)).toBeVisible();
});

test('Settings Privacy retains keyboard ownership through browser-clear recovery', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?browser_clear=fail-slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const clear = page.locator(`[${CLEAR_THIS_BROWSER_CLEAR}]`);
  await clear.focus();
  await page.keyboard.press('Enter');
  const confirm = page.locator(`[${CLEAR_THIS_BROWSER_CONFIRM}]`);
  await confirm.focus();
  await page.keyboard.press('Enter');

  const status = page.locator(`[${CLEAR_THIS_BROWSER_STATUS}]`);
  await expect(status).toHaveText('Clearing…');
  await expect(status).toBeFocused();
  await expect(status).toContainText(
    'Browser key storage is temporarily unavailable.',
  );
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(status).toHaveAttribute('tabindex', '-1');
  await expect(status).toBeFocused();

  const retry = page.locator(`[${CLEAR_THIS_BROWSER_RETRY}]`);
  await retry.focus();
  await page.keyboard.press('Enter');
  const cancel = page.locator(`[${CLEAR_THIS_BROWSER_CANCEL}]`);
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(clear).toBeFocused();
});

const settingsNavItemIsVisible = (item: HTMLElement, navAttr: string): boolean => {
  const rail = item.closest<HTMLElement>(`[${navAttr}]`);
  if (rail === null) return false;
  const railRect = rail.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const left = railRect.left + rail.clientLeft;
  // Scroll alignment can finish on a fractional CSS pixel at the strip edge.
  return itemRect.left >= left - 1 && itemRect.right <= left + rail.clientWidth + 1;
};

test('Settings reveals the active section in its mobile overflow rail', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(() => window.__app.setHash('#settings/server'));

  const nav = page.locator(`[${SETTINGS_NAV}]`);
  const server = page.locator(`[${SETTINGS_NAV_ITEM}="server"]`);
  const targetHeights = await nav.locator('button').evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().height)
  );
  expect(Math.min(...targetHeights)).toBeGreaterThanOrEqual(36);
  await expect(server).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => server.evaluate(settingsNavItemIsVisible, SETTINGS_NAV)).toBe(true);
  expect(await nav.evaluate((rail) => rail.scrollLeft)).toBeGreaterThan(0);
});

for (const width of [280, 390, 720]) {
  test(`Settings fully reveals keyboard-focused rail items at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.__app.setHash('#settings/account'));
    const items = page.locator(`[${SETTINGS_NAV_ITEM}]`);
    await expect(items.first()).toBeVisible();
    const count = await items.count();
    // Use WebKit's full keyboard navigation shortcut for ordinary buttons.
    const next = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    const previous = browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab';
    await items.first().focus();
    await page.keyboard.press(previous);
    await page.keyboard.press(next);
    for (let index = 0; index < count; index++) {
      const item = items.nth(index);
      await expect(item).toBeFocused();
      await expect.poll(() => item.evaluate(settingsNavItemIsVisible, SETTINGS_NAV)).toBe(true);
      if (index < count - 1) await page.keyboard.press(next);
    }
    await expect(page).toHaveURL(/#settings\/account$/);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#settings\/server$/);
    await expect(items.last()).toBeFocused();
    for (let index = count - 2; index >= 0; index--) {
      await page.keyboard.press(previous);
      const item = items.nth(index);
      await expect(item).toBeFocused();
      await expect.poll(() => item.evaluate(settingsNavItemIsVisible, SETTINGS_NAV)).toBe(true);
    }
  });
}

test('Settings preserves navigation visibility and focus through resizing', async ({ page }) => {
  await page.setViewportSize({ width: 721, height: 900 });
  await page.evaluate(() => window.__app.setHash('#settings/account'));
  const server = page.locator(`[${SETTINGS_NAV_ITEM}="server"]`);
  await server.focus();
  for (const width of [720, 390, 280, 721]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(server).toBeFocused();
    await expect.poll(() => server.evaluate(settingsNavItemIsVisible, SETTINGS_NAV)).toBe(true);
  }
  await expect(page).toHaveURL(/#settings\/account$/);

  await page.goto(`${HARNESS_URL}?settle_reads=1#settings/server`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const section = page.locator('[data-recued-settings-section="server"]');
  await section.focus();
  for (const width of [720, 390, 280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(section).toBeFocused();
    await expect.poll(() => server.evaluate(settingsNavItemIsVisible, SETTINGS_NAV)).toBe(true);
  }
  await section.evaluate((owner) => owner.scrollIntoView({ block: 'start' }));
  const verticalScroll = () => page.evaluate(() => ({
    window: window.scrollY,
    content: document.querySelector('[data-recued-webclient-content]')?.scrollTop,
  }));
  const before = await verticalScroll();
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  expect(await verticalScroll()).toEqual(before);
  await expect(section).toBeFocused();
});

test('Settings omits retired Work Entities controls and recovers their old link', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?work_entities=multiple-sources&settle_reads=1#settings/work-entities`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  // D-187 retired source defaults and muting. Old links use the Settings fallback.
  await expect(page.getByRole('heading', { name: 'Account', level: 2 }))
    .toBeVisible();
  await expect(page.locator(`[${SETTINGS_NAV_ITEM}="account"]`))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.locator(`[${SETTINGS_NAV_ITEM}="work-entities"]`))
    .toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Work Entities' }))
    .toHaveCount(0);
  await expect(page.locator(
    '[data-action="set-source-enabled"], '
      + '[data-action="set-source-mcp-exposed"], '
      + '[data-action="set-default-source"]',
  )).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.source.list')))
    .toBe(0);

  await page.locator(`[${SETTINGS_NAV_ITEM}="privacy"]`).click();
  await expect(page.getByRole('heading', { name: 'Privacy', level: 2 }))
    .toBeVisible();
  await expect(page).toHaveURL(/#settings\/privacy$/);
  await expect(page.locator('html')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('html').evaluate((element) => element.clientWidth),
  );
});

test('Settings Seller directory does not repeat its page heading', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/seller'));

  await expect(page.getByRole('heading', {
    name: 'Seller tools',
    exact: true,
  })).toBeVisible();
  await expect(page.getByRole('heading', {
    name: 'Seller',
    exact: true,
  })).toHaveCount(1);
});

test('Settings Seller previews a row before Enter opens its detail', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?settle_reads=1#settings/seller/customers`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const link = page.locator(
    '[data-recued-seller-collection-item-link="customer-1"]',
  );
  await expect(link).toBeVisible();
  await link.click();

  const preview = page.locator(`[${LIST_PREVIEW}]`);
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'customer-shared' }))
    .toBeVisible();
  await expect(page).toHaveURL(/#settings\/seller\/customers$/);
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(link).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(
    /#settings\/seller\/customers\/detail\/customer-1$/,
  );
  await expect(page.locator(
    '[data-recued-seller-collection-detail="customer-1"]',
  )).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#settings\/seller\/customers$/);
  await expect(link).toBeFocused();
});

test('Settings Seller keeps mobile navigation and disclosures full-size', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  for (const hash of [
    '#settings/seller/orders',
    '#settings/seller/offers',
    '#settings/seller/tiers',
    '#settings/seller/customers/detail/customer-1',
  ]) {
    await page.goto(`${HARNESS_URL}?settle_reads=1${hash}`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(page.locator(
      '[data-recued-seller-page-state="ready"]',
    )).toBeVisible();

    const links = page.locator([
      '[data-recued-seller-back]:visible',
      '[data-recued-seller-collection-item-link]:visible',
      '[data-recued-seller-page-previous]:visible',
      '[data-recued-seller-page-next]:visible',
      '[data-recued-seller-contract-link]:visible',
      '.seller-related-links a:visible',
    ].join(', '));
    const linkHeights = await links.evaluateAll((targets) => targets.map(
      (target) => target.getBoundingClientRect().height,
    ));
    expect(linkHeights.length).toBeGreaterThan(0);
    expect(Math.min(...linkHeights)).toBeGreaterThanOrEqual(36);

    const buttonHeights = await page.locator(
      '[data-recued-seller-page] button:visible',
    ).evaluateAll((buttons) => buttons.map(
      (button) => button.getBoundingClientRect().height,
    ));
    expect(buttonHeights.length).toBeGreaterThan(0);
    expect(Math.min(...buttonHeights)).toBeGreaterThanOrEqual(36);

    const summaryHeights = await page.locator(
      '[data-recued-seller-page] summary:visible',
    ).evaluateAll((summaries) => summaries.map(
      (summary) => summary.getBoundingClientRect().height,
    ));
    expect(summaryHeights.every((height) => height >= 36)).toBe(true);

    const seller = page.locator('[data-recued-seller-page]');
    expect(await seller.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    )).toBe(true);

    if (hash.includes('/customers/detail/')) {
      const contractReference = seller.locator(
        `[${SHARED_REFERENCE_ID}="door_paged_01"]`,
      );
      await expect(contractReference).toHaveAttribute(
        SHARED_REFERENCE,
        'identity',
      );
      await expect(contractReference).toHaveAttribute(
        SHARED_REFERENCE_ID,
        'door_paged_01',
      );
    }
  }
});

test('Settings Seller Orders distinguishes repeated offer links', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/seller/orders'));

  const orderLink = (orderKey: string) => page.locator(
    `[data-recued-seller-collection-item-link="${orderKey}"]`,
  );
  await expect(orderLink('ord:access:claim-mail-1')).toHaveAccessibleName(
    'Preview order ord:access:claim-mail-1 for offer-1; press Enter to open',
  );
  await expect(orderLink('ord:access:claim-mail-2')).toHaveAccessibleName(
    'Preview order ord:access:claim-mail-2 for offer-1; press Enter to open',
  );
});

test('Settings Seller Usage distinguishes rollups for one contract', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/seller/usage'));

  const usageLink = (itemId: string) => page.locator(
    `[data-recued-seller-collection-item-link="${itemId}"]`,
  );
  await expect(usageLink(
    'door_paged_01:tool_call:day:1700000000000',
  )).toHaveAccessibleName(
    'Preview Tool Call usage for door_paged_01 (day 1700000000000); press Enter to open',
  );
  await expect(usageLink(
    'door_paged_01:chat_turn:day:1700000000000',
  )).toHaveAccessibleName(
    'Preview Chat Turn usage for door_paged_01 (day 1700000000000); press Enter to open',
  );
});

test('Settings Seller Offers distinguishes duplicate display names', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/seller/offers'));

  const offerLink = (offerId: string) => page.locator(
    `[data-recued-seller-collection-item-link="${offerId}"]`,
  );
  await expect(offerLink('offer-1')).toHaveAccessibleName(
    'Preview offer offer-1 (Consultation); press Enter to open',
  );
  await expect(offerLink('offer-2')).toHaveAccessibleName(
    'Preview offer offer-2 (Consultation); press Enter to open',
  );
});

test('Settings Seller Tiers distinguishes duplicate display names', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/seller/tiers'));

  const tierLink = (tierId: string) => page.locator(
    `[data-recued-seller-collection-item-link="${tierId}"]`,
  );
  await expect(tierLink('tier-standard')).toHaveAccessibleName(
    'Preview tier tier-standard (Standard); press Enter to open',
  );
  await expect(tierLink('tier-standard-annual')).toHaveAccessibleName(
    'Preview tier tier-standard-annual (Standard); press Enter to open',
  );
});

test('Settings Seller Customers distinguishes shared provider ids', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/seller/customers'));

  const customerLink = (customerId: string) => page.locator(
    `[data-recued-seller-collection-item-link="${customerId}"]`,
  );
  await expect(customerLink('customer-1')).toHaveAccessibleName(
    'Preview customer customer-1 (customer-shared); press Enter to open',
  );
  await expect(customerLink('customer-2')).toHaveAccessibleName(
    'Preview customer customer-2 (customer-shared); press Enter to open',
  );
});

test('Settings Seller customer lifecycle distinguishes repeated fields', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    window.__app.setHash('#settings/seller/customers/detail/customer-1');
  });
  await expect(page.getByRole('heading', {
    name: 'Look after someone’s access',
  })).toBeVisible();
  await page.locator(
    '[data-recued-seller-collection-detail="customer-1"] details',
  ).evaluateAll((details: HTMLDetailsElement[]) => {
    for (const detail of details) detail.open = true;
  });

  const field = (name: string) => page.locator(
    `[data-recued-seller-customer-lifecycle-field="${name}"]`,
  );
  for (const [name, accessibleName] of [
    ['extend.customer_id', 'Who to give longer'],
    ['swap.customer_id', 'Who to move'],
    ['close.customer_id', 'Customer to close'],
    ['reissue.customer_id', 'Customer to reissue'],
    ['message.customer_id', 'Customer to message'],
    ['extend.current_period_end', 'New end time'],
    ['swap.current_period_end', 'New end time'],
    ['extend.source_status', 'Extension source status'],
    ['swap.source_status', 'Swap source status'],
    ['close.source_status', 'Close source status'],
  ] as const) {
    await expect(field(name)).toHaveAccessibleName(accessibleName);
  }
});

test('Settings Seller confirmation dialog owns keyboard focus', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    window.__app.setHash(
      '#settings/seller/orders/detail/ord%3Aaccess%3Aclaim-mail-1',
    );
  });

  const trigger = page.locator(
    '[data-recued-seller-order-close="ord:access:claim-mail-1"]',
  );
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Close this order?' });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const confirm = dialog.getByRole('button', { name: 'Confirm & close' });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  const next = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  await page.keyboard.press(next);
  await expect(confirm).toBeFocused();
  await page.keyboard.press(next);
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Settings Server Key Health distinguishes repeated key actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/server/key-health'));

  const keyAction = (action: 'rotate' | 'compromise', keyClass: string) =>
    page.locator(`[data-recued-key-health-${action}="${keyClass}"]`);
  await expect(keyAction('rotate', 'server_identity_key')).toHaveAccessibleName(
    'Rotate Server identity key now',
  );
  await expect(keyAction('compromise', 'server_identity_key'))
    .toHaveAccessibleName('Mark Server identity key compromised');
  await expect(keyAction('rotate', 'master_dek')).toHaveAccessibleName(
    'Rotate Master encryption key now',
  );
  await expect(keyAction('compromise', 'master_dek')).toHaveAccessibleName(
    'Mark Master encryption key compromised',
  );
  await expect(keyAction('rotate', 'publisher_identity_key'))
    .toHaveAccessibleName('Rotate Publisher identity key now');
  await expect(keyAction('compromise', 'publisher_identity_key'))
    .toHaveAccessibleName('Mark Publisher identity key compromised');
});

test('Settings Server Key Health states the unsealed backup boundary', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/server/key-health'));

  const posture = page.locator('[data-recued-keyfile-posture]');
  await expect(posture).toHaveAttribute(
    'data-recued-keyfile-posture-tone',
    'unsealed',
  );
  const consequence = posture.getByRole('alert');
  await expect(consequence).toContainText(
    'anyone who copies that whole folder gets everything in it',
  );
  await expect(consequence).toContainText(
    'Only a copy that leaves the keyfile out',
  );
  await expect(consequence).toContainText('database-only backup');
});

test('Settings Server Key Health retains confirmation focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/server/key-health'));

  const trigger = page.locator(
    '[data-recued-key-health-rotate="master_dek"]',
  );
  await trigger.click();
  const cancel = page.locator('[data-recued-key-health-cancel]');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator(
    '[data-recued-key-health-panel-state="idle"]',
  )).toBeVisible();
  await expect(trigger).toBeFocused();
});

test('Settings Server Maintenance dialog owns keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/server/maintenance'));

  const trigger = page.getByRole('button', {
    name: 'Run audit-compaction now',
  });
  await trigger.click();

  const dialog = page.getByRole('dialog', {
    name: 'Run "Compact repetitive audit rows"?',
  });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const confirm = dialog.getByRole('button', { name: 'Run now' });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('housekeeping.task.run_now'))).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Settings Updates Check stays owned through failure and retry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?updates=fail-once-slow-retry`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/updates'));

  const check = page.locator(`[${UPDATES_CHECK}]`);
  const status = page.locator(`[${UPDATES_STATUS}]`);
  const error = page.locator(`[${UPDATES_ERROR}]`);
  await expect(check).toHaveText('Check for updates');
  await expect(status).toContainText('latest version');
  await expect(page.locator(`[${UPDATES_MODE}]`)).toHaveAccessibleName(
    'When updates are available',
  );
  expect((await check.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  const checksBefore = await page.evaluate(
    () => window.__app.rpcCallCount('update.check'),
  );

  await check.focus();
  await page.keyboard.press('Enter');
  await expect(check).toHaveText('Checking…');
  await expect(check).toHaveAttribute('aria-disabled', 'true');
  await expect(check).toHaveAttribute('aria-busy', 'true');
  await expect(check).not.toHaveAttribute('disabled');
  await expect(check).toBeFocused();
  await check.dispatchEvent('click');
  await check.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('update.check')),
  ).toBe(checksBefore + 1);

  await expect(error).toContainText('update check could not be completed');
  await expect(check).toHaveText('Check for updates');
  await expect(check).not.toHaveAttribute('aria-disabled');
  await expect(check).not.toHaveAttribute('aria-busy');
  await expect(check).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(status).toContainText('latest version');
  await expect(error).toBeHidden();
  await expect(check).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('update.check')),
  ).toBe(checksBefore + 2);
});

test('Settings Updates retains a pending rollback when navigation is declined', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?updates=ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/updates'));

  const rollback = page.locator(`[${UPDATES_ROLLBACK}]`);
  expect((await rollback.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  const html = page.locator('html');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
  });

  await rollback.focus();
  await page.keyboard.press('Enter');
  await expect(rollback).toHaveText('Rolling back…');
  await expect(rollback).not.toHaveAttribute('disabled');
  await expect(rollback).toHaveAttribute('aria-disabled', 'true');
  await expect(rollback).toHaveAttribute('aria-busy', 'true');
  await expect(rollback).toBeFocused();
  await rollback.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('update.rollback')),
  ).toBe(1);
  await page.evaluate(() => window.__app.setHash('#chat'));

  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A server update change is still in progress. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/updates$/);
  await expect(rollback).toHaveText('Rolling back…');
});

test('Settings Updates retains focus and ownership through a deferred apply', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?updates=available-slow-apply`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/updates'));

  const apply = page.locator(`[${UPDATES_APPLY}]`);
  const html = page.locator('html');
  await expect(apply).toHaveText('Update to 26.8.1');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
  });

  await apply.focus();
  // Every update asks once: Update to <version> → Confirm update → Updating….
  await page.keyboard.press('Enter');
  await expect(apply).toHaveText('Confirm update');
  await expect(apply).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(apply).toHaveText('Updating…');
  await expect(apply).not.toHaveAttribute('disabled');
  await expect(apply).toHaveAttribute('aria-disabled', 'true');
  await expect(apply).toHaveAttribute('aria-busy', 'true');
  await expect(apply).toBeFocused();
  await apply.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('update.apply')),
  ).toBe(1);

  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A server update change is still in progress. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/updates$/);

  // The confirm was used up by that apply, so the next attempt asks again.
  await expect(apply).toHaveText('Update to 26.8.1');
  await expect(apply).not.toHaveAttribute('aria-disabled');
  await expect(apply).not.toHaveAttribute('aria-busy');
  await expect(apply).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings Account gives dashboard handoffs full mobile targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?account=bound#settings/account`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const links = page.locator('.account-bind-dashboard-link');
  await expect(links).toHaveCount(3);
  const targets = await links.evaluateAll((elements) =>
    elements.map((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      target: element.getAttribute('target'),
      rel: element.getAttribute('rel'),
    }))
  );
  expect(Math.min(...targets.map((target) => target.width)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.min(...targets.map((target) => target.height)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.max(...targets.map((target) => target.height)))
    .toBeLessThanOrEqual(44);
  expect(targets.every((target) => target.target === '_blank')).toBe(true);
  expect(targets.every((target) => target.rel === 'noopener noreferrer'))
    .toBe(true);
});

test('Settings Account Connect owns its pending command and refreshed binding', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=unbound&account_bind_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const connect = page.locator('[data-recued-account-binding-connect]');
  await expect(connect).toHaveText('Connect your recued.com account');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
  });
  await connect.focus();
  await page.keyboard.press('Enter');
  await expect(connect).toHaveText('Connecting…');
  await expect(connect).toHaveAttribute('aria-disabled', 'true');
  await expect(connect).toHaveAttribute('aria-busy', 'true');
  await expect(connect).not.toHaveAttribute('disabled');
  await expect(connect).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'An account setting is still updating. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/account$/);
  await connect.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('account.bind')),
  ).toBe(1);

  await expect(connect).toHaveText('Check the connection again');
  await expect(connect).not.toHaveAttribute('aria-disabled');
  await expect(connect).not.toHaveAttribute('aria-busy');
  await expect(connect).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-action-message]'))
    .toHaveText('Your server is hooked up to this recued.com account.');
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings Account Connect failures return to the exact command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=unbound&account_bind_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const connect = page.locator('[data-recued-account-binding-connect]');
  await connect.focus();
  await page.keyboard.press('Enter');
  await expect(connect).toHaveText('Connecting…');

  await expect(page.locator('[data-recued-account-binding-error="action"]'))
    .toHaveText('Account binding unavailable.');
  await expect(connect).toHaveText('Connect your recued.com account');
  await expect(connect).not.toHaveAttribute('aria-disabled');
  await expect(connect).not.toHaveAttribute('aria-busy');
  await expect(connect).not.toHaveAttribute('disabled');
  await expect(connect).toBeFocused();
});

test('Settings Account conflicts start safely and Cancel returns to Check the connection again', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?account=conflict`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const connect = page.locator('[data-recued-account-binding-connect]');
  await expect(connect).toHaveText('Check the connection again');
  await connect.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: 'Two accounts want this server' });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(connect).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-action-message]'))
    .toHaveText('Nothing was moved.');
});

test('Settings Account Yes, move it owns its pending command and refreshed binding', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=conflict&account_rebind_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const connect = page.locator('[data-recued-account-binding-connect]');
  await connect.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: 'Two accounts want this server' });
  const confirm = dialog.locator(
    '[data-recued-account-binding-confirm-rebind]',
  );
  const cancel = dialog.locator(
    '[data-recued-account-binding-cancel-rebind]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Rebinding…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await expect(cancel).not.toHaveAttribute('disabled');
  await confirm.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('account.bind')),
  ).toBe(2);

  await expect(dialog).toHaveCount(0);
  await expect(connect).toHaveText('Check the connection again');
  await expect(connect).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-action-message]'))
    .toHaveText('Your server now belongs to this recued.com account.');
});

test('Settings Account Yes, move it failures return to the exact command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=conflict&account_rebind_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const connect = page.locator('[data-recued-account-binding-connect]');
  await connect.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: 'Two accounts want this server' });
  const confirm = dialog.locator(
    '[data-recued-account-binding-confirm-rebind]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Rebinding…');
  await expect(confirm).toBeFocused();

  await expect(page.locator('[data-recued-account-binding-error="action"]'))
    .toHaveText('Account rebind unavailable.');
  await expect(dialog).toBeVisible();
  await expect(confirm).toHaveText('Yes, move it');
  await expect(confirm).not.toHaveAttribute('aria-disabled');
  await expect(confirm).not.toHaveAttribute('aria-busy');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
});

test('Settings Account Disconnect starts safely and Cancel returns to its command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?account=conflict`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const disconnect = page.locator('[data-recued-account-binding-unbind]');
  await disconnect.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', {
    name: 'Disconnect this server?',
  });
  const cancel = dialog.locator(
    '[data-recued-account-binding-cancel-unbind]',
  );
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    'This browser stays signed in, and you can hook the server back up later.',
  );
  await expect(cancel).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('account.unbind'),
  )).toBe(0);

  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(disconnect).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('account.unbind'),
  )).toBe(0);
});

test('Settings Account Confirm Disconnect owns its pending command and next action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=conflict&account_unbind_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  await page.locator('[data-recued-account-binding-unbind]').click();
  const dialog = page.getByRole('alertdialog', {
    name: 'Disconnect this server?',
  });
  const confirm = dialog.locator(
    '[data-recued-account-binding-confirm-unbind]',
  );
  const cancel = dialog.locator(
    '[data-recued-account-binding-cancel-unbind]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Disconnecting…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await expect(cancel).not.toHaveAttribute('disabled');
  await confirm.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('account.unbind')),
  ).toBe(1);

  await expect(dialog).toHaveCount(0);
  const connect = page.locator('[data-recued-account-binding-connect]');
  await expect(connect).toHaveText('Connect your recued.com account');
  await expect(connect).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-action-message]'))
    .toHaveText('Your server is no longer hooked up to recued.com.');
  await expect(page.locator('[data-recued-account-binding-session]'))
    .toHaveText('Signed in as morgan@example.test');
});

test('Settings Account Confirm Disconnect failures return to the exact command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=conflict&account_unbind_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  await page.locator('[data-recued-account-binding-unbind]').click();
  const dialog = page.getByRole('alertdialog', {
    name: 'Disconnect this server?',
  });
  const confirm = dialog.locator(
    '[data-recued-account-binding-confirm-unbind]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Disconnecting…');
  await expect(confirm).toBeFocused();

  await expect(page.locator('[data-recued-account-binding-error="action"]'))
    .toHaveText('Account disconnect unavailable.');
  await expect(dialog).toBeVisible();
  await expect(confirm).toHaveText('Disconnect server');
  await expect(confirm).not.toHaveAttribute('aria-disabled');
  await expect(confirm).not.toHaveAttribute('aria-busy');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('account.unbind'),
  )).toBe(1);
});

test('Settings Account Sign out owns its pending command and next action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=bound&account_signout_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const signOut = page.locator('[data-recued-account-binding-signout]');
  await signOut.focus();
  await page.keyboard.press('Enter');
  await expect(signOut).toHaveText('Signing out…');
  await expect(signOut).toHaveAttribute('aria-disabled', 'true');
  await expect(signOut).toHaveAttribute('aria-busy', 'true');
  await expect(signOut).not.toHaveAttribute('disabled');
  await expect(signOut).toBeFocused();
  await signOut.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.accountSignOutCount?.()),
  ).toBe(1);

  await expect(signOut).toHaveCount(0);
  const connect = page.locator('[data-recued-account-binding-connect]');
  await expect(connect).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-session]'))
    .toHaveCount(0);
  await expect(page.locator('[data-recued-account-binding-action-message]'))
    .toHaveText(
      'Signed out of recued.com in this browser. Your server is still paired.',
    );
});

test('Settings Account Sign out failures return to the exact command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=bound&account_signout_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const signOut = page.locator('[data-recued-account-binding-signout]');
  await signOut.focus();
  await page.keyboard.press('Enter');
  await expect(signOut).toHaveText('Signing out…');
  await expect(signOut).toBeFocused();

  await expect(page.locator('[data-recued-account-binding-error="action"]'))
    .toHaveText('Account sign out unavailable.');
  await expect(signOut).toHaveText('Sign out');
  await expect(signOut).not.toHaveAttribute('aria-disabled');
  await expect(signOut).not.toHaveAttribute('aria-busy');
  await expect(signOut).not.toHaveAttribute('disabled');
  await expect(signOut).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.accountSignOutCount?.(),
  )).toBe(1);
});

test('Settings Account read failures gate mutations and recover in place', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=read-fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const errors = page.locator('[data-recued-account-binding-error]');
  await expect(errors).toHaveCount(2);
  await expect(errors).toContainText([
    'Account binding status unavailable.',
    'Account plan status unavailable.',
  ]);
  expect(await page.evaluate(
    () => window.__app.accountSessionReadCount?.(),
  )).toBe(0);
  const connect = page.locator('[data-recued-account-binding-connect]');
  await expect(connect).toHaveCount(0);

  const retry = page.locator('[data-recued-account-binding-retry]');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Checking your account again…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('account.bindingStatus')),
  ).toBe(2);
  await expect(connect).toHaveCount(0);

  await expect(errors).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(connect).toHaveText('Connect your recued.com account');
  await expect(connect).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-session]'))
    .toHaveCount(0);
  expect(await page.evaluate(
    () => window.__app.accountSessionReadCount?.(),
  )).toBe(0);
});

test('Settings Account retry failures return to the exact recovery command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=read-fail-twice-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const errors = page.locator('[data-recued-account-binding-error]');
  await expect(errors).toHaveCount(2);
  await expect(errors).toContainText([
    'Account binding status unavailable.',
    'Account plan status unavailable.',
  ]);
  expect(await page.evaluate(
    () => window.__app.accountSessionReadCount?.(),
  )).toBe(0);
  const retry = page.locator('[data-recued-account-binding-retry]');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Checking your account again…');
  await expect(retry).toBeFocused();

  await expect(errors).toHaveCount(1);
  await expect(errors.filter({
    hasText: 'Account binding status unavailable.',
  })).toHaveCount(1);
  await expect(retry).toHaveText('Check your account again');
  await expect(retry).not.toHaveAttribute('aria-disabled');
  await expect(retry).not.toHaveAttribute('aria-busy');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-connect]'))
    .toHaveCount(0);
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('account.bindingStatus'),
  )).toBe(2);
  expect(await page.evaluate(
    () => window.__app.accountSessionReadCount?.(),
  )).toBe(0);
});

test('Settings device revoke confirmation starts safely and returns to its row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?devices=ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));

  const currentRow = page.locator(
    '.account-devices-row[data-instance-id="device-current"]',
  );
  await expect(currentRow).toContainText('This device');
  await expect(currentRow.locator('[data-action="revoke-device"]')).toHaveCount(0);

  const revoke = page.locator(
    '[data-action="revoke-device"][data-instance-id="device-laptop"]',
  );
  await expect(revoke).toHaveAccessibleName(
    'Revoke Travel laptop (device-laptop)',
  );
  await expect(page.locator(
    '[data-action="revoke-device"][data-instance-id="device-desktop"]',
  )).toHaveAccessibleName('Revoke Office desktop (device-desktop)');
  await revoke.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', {
    name: 'Confirm revoke Travel laptop (device-laptop)',
  });
  const cancel = dialog.getByRole('button', {
    name: 'Cancel revoke Travel laptop (device-laptop)',
  });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await expect(dialog.getByRole('button', {
    name: 'Confirm revoke Travel laptop (device-laptop)',
  })).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(revoke).toBeFocused();
});

test('Settings device revoke owns its pending command and success receipt', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?devices=ready&device_revoke_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));

  const revoke = page.locator(
    '[data-action="revoke-device"][data-instance-id="device-laptop"]',
  );
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
  });
  await revoke.click();
  const confirm = page.locator(
    '[data-action="confirm-revoke"][data-instance-id="device-laptop"]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');

  await expect(confirm).toHaveText('Revoking…');
  await expect(confirm).toHaveAccessibleName(
    'Revoking Travel laptop (device-laptop)',
  );
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Recued is still shutting a device out. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/devices$/);
  await confirm.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('pair.revoke')),
  ).toBe(1);

  await expect(revoke).toHaveCount(0);
  const receipt = page.locator('[data-device-revoke-success]');
  await expect(receipt).toContainText('Done. That device can no longer reach this server.');
  await expect(receipt).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings failed device revokes return to the exact retry action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?devices=ready&device_revoke_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));

  await page.locator(
    '[data-action="revoke-device"][data-instance-id="device-laptop"]',
  ).click();
  const confirm = page.locator(
    '[data-action="confirm-revoke"][data-instance-id="device-laptop"]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Revoking…');

  await expect(page.locator('.account-devices-confirm-error'))
    .toHaveText(
      'Recued could not shut this device out: Device revoke unavailable. '
        + 'Try again, or do it from another device you have paired.',
    );
  await expect(confirm).toContainText('Yes, revoke');
  await expect(confirm).not.toHaveAttribute('aria-disabled');
  await expect(confirm).not.toHaveAttribute('aria-busy');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
});

for (const width of [390, 1280]) {
  for (const newerFirst of [true, false]) {
    test(`Settings Devices completes a revoke from the latest broadcast (newer first: ${newerFirst}) at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${HARNESS_URL}?devices=ready`);
      await page.waitForFunction(() => window.__app?.ready === true);
      await page.evaluate(() => window.__app.setHash('#settings/devices'));
      const laptop = page.locator('.account-devices-row[data-instance-id="device-laptop"]');
      await expect(laptop).toBeVisible();
      await page.evaluate(() => window.__app.holdRpcResponses?.('pair.list'));
      await laptop.locator('[data-action="revoke-device"]').click();
      await page.locator('[data-action="confirm-revoke"][data-instance-id="device-laptop"]').focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('pair.list'))).toBe(2);
      await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
        kind: 'pair.list_changed', op: 'revoked', cursor: 2,
      } }));
      await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('pair.list'))).toBe(3);
      if (!newerFirst) {
        expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list', 0))).toBe(1);
        await page.evaluate(() => {
          window.confirm = (message?: string): boolean => {
            document.documentElement.setAttribute('data-device-leave-prompt', message ?? '');
            return false;
          };
          window.__app.setHash('#chat');
        });
        await expect(page.locator('html')).toHaveAttribute('data-device-leave-prompt',
          'Recued is still shutting a device out. Leave Settings anyway?');
        await expect(page).toHaveURL(/#settings\/devices$/);
      }
      expect(await page.evaluate(index => window.__app.releaseRpcResponses?.('pair.list', index), newerFirst ? 1 : 0)).toBe(1);
      await expect(laptop).toHaveCount(0);
      await expect(page.locator('[data-device-revoke-success]')).toBeFocused();
      await page.locator('[data-action="revoke-device"][data-instance-id="device-desktop"]').click();
      const cancel = page.locator('[data-action="cancel-revoke"][data-instance-id="device-desktop"]');
      await expect(cancel).toBeFocused();
      if (newerFirst) expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list', 0))).toBe(1);
      await expect(cancel).toBeFocused();
      await expect(laptop).toHaveCount(0);
      expect(await page.evaluate(() => window.__app.rpcCallCount('pair.revoke'))).toBe(1);
      expect(await page.evaluate(() => window.__app.rpcCallCount('pair.list'))).toBe(3);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list'))).toBe(0);
    });
  }

  test(`Settings Devices keeps a reconciled revoke after an older roster arrives at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HARNESS_URL}?devices=ready`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.evaluate(() => window.__app.setHash('#settings/devices'));
    const laptop = page.locator('.account-devices-row[data-instance-id="device-laptop"]');
    await expect(laptop).toBeVisible();
    await page.evaluate(() => {
      window.__app.holdRpcResponses?.('pair.list');
      window.__app.fireMessage({ type: 'server_event', event: {
        kind: 'pair.list_changed', op: 'added', cursor: 1,
      } });
    });
    await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('pair.list'))).toBe(2);

    await laptop.locator('[data-action="revoke-device"]').click();
    await page.locator('[data-action="confirm-revoke"][data-instance-id="device-laptop"]').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('pair.list'))).toBe(3);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list', 1))).toBe(1);
    await expect(laptop).toHaveCount(0);
    const receipt = page.locator('[data-device-revoke-success]');
    await expect(receipt).toBeFocused();
    const desktop = page.locator('[data-action="revoke-device"][data-instance-id="device-desktop"]');
    await desktop.focus();
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list', 0))).toBe(1);
    await expect(desktop).toBeFocused();
    await expect(laptop).toHaveCount(0);
    await expect(receipt).toContainText('Done. That device can no longer reach this server.');
    await expect(page.locator('[data-error="list"]')).toHaveCount(0);
    await expect(page.locator('.account-devices-loading')).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('pair.revoke'))).toBe(1);
    expect(await page.evaluate(() => window.__app.rpcCallCount('pair.list'))).toBe(3);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list'))).toBe(0);
  });

  test(`Settings Devices ignores an older list error after a successful broadcast refresh at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HARNESS_URL}?devices=fail-once-slow-retry&hold_rpc=pair.list`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.evaluate(() => window.__app.setHash('#settings/devices'));
    await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('pair.list'))).toBe(1);
    await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
      kind: 'pair.list_changed', op: 'added', cursor: 1,
    } }));
    await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('pair.list'))).toBe(2);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list', 1))).toBe(1);
    const desktop = page.locator('[data-action="revoke-device"][data-instance-id="device-desktop"]');
    await desktop.focus();
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list', 0))).toBe(1);
    await expect(desktop).toBeFocused();
    await expect(page.locator('[data-error="list"]')).toHaveCount(0);
    await expect(page.locator('.account-devices-loading')).toHaveCount(0);
    await expect(page.locator('.account-devices-row')).toHaveCount(3);
    expect(await page.evaluate(() => window.__app.rpcCallCount('pair.list'))).toBe(2);
    expect(await page.evaluate(() => window.__app.rpcCallCount('pair.revoke'))).toBe(0);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list'))).toBe(0);
  });
}

for (const width of [390, 1280]) {
  test(`Settings Devices Refresh keeps its busy owner and later confirmation focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HARNESS_URL}?devices=ready`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.evaluate(() => window.__app.setHash('#settings/devices'));
    const checked = page.locator('[data-devices-last-checked] time');
    await expect(checked).toBeVisible();
    const lastSuccessfulAt = await checked.getAttribute('datetime');
    await page.locator('[data-action="revoke-device"][data-instance-id="device-laptop"]').click();
    const cancel = page.locator('[data-action="cancel-revoke"][data-instance-id="device-laptop"]');
    await expect(cancel).toBeFocused();
    await page.evaluate(() => window.__app.holdRpcResponses?.('pair.list'));

    const refresh = page.getByRole('button', { name: 'Refresh devices', exact: true });
    await refresh.focus();
    await page.keyboard.press('Enter');
    await expect(refresh).toHaveText('Refreshing…');
    await expect(refresh).toHaveAttribute('aria-disabled', 'true');
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await expect(refresh).not.toHaveAttribute('disabled');
    await expect(refresh).toBeFocused();
    await expect(checked).toHaveAttribute('datetime', lastSuccessfulAt!);
    await expect(cancel).toBeVisible();
    await refresh.evaluate((button: HTMLElement) => { button.click(); button.click(); });
    expect(await page.evaluate(() => window.__app.rpcCallCount('pair.list'))).toBe(2);

    await cancel.focus();
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list'))).toBe(1);
    await expect(refresh).toHaveText('Refresh');
    await expect(refresh).not.toHaveAttribute('aria-disabled');
    await expect(refresh).not.toHaveAttribute('aria-busy');
    await expect(cancel).toBeFocused();
    await expect(page.locator('[data-devices-last-checked]')).toContainText('Last successful check:');
    expect(await page.evaluate(() => window.__app.rpcCallCount('pair.revoke'))).toBe(0);
    const toolbar = await page.locator('.account-devices-refresh').boundingBox();
    expect(toolbar).not.toBeNull();
    expect(toolbar!.x).toBeGreaterThanOrEqual(0);
    expect(toolbar!.x + toolbar!.width).toBeLessThanOrEqual(width);
  });

  test(`Settings Devices preserves the exact confirmation control through background checks at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${HARNESS_URL}?devices=ready`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.evaluate(() => window.__app.setHash('#settings/devices'));
    await page.locator('[data-action="revoke-device"][data-instance-id="device-laptop"]').click();
    const confirm = page.locator('[data-action="confirm-revoke"][data-instance-id="device-laptop"]');
    await confirm.focus();
    await page.evaluate(() => {
      window.__app.holdRpcResponses?.('pair.list');
      window.__app.fireMessage({ type: 'server_event', event: {
        kind: 'pair.list_changed', op: 'added', cursor: 1,
      } });
    });
    const refresh = page.getByRole('button', { name: 'Refresh devices', exact: true });
    await expect(refresh).toHaveText('Refreshing…');
    await expect(confirm).toBeFocused();
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list'))).toBe(1);
    await expect(refresh).toHaveText('Refresh');
    await expect(confirm).toBeFocused();
    expect(await page.evaluate(() => window.__app.rpcCallCount('pair.revoke'))).toBe(0);
  });
}

test('Settings Devices refresh survives unavailable locale APIs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?devices=ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));
  const checked = page.locator('[data-devices-last-checked]');
  await expect(checked.locator('time')).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(Intl, 'DateTimeFormat', { configurable: true, value: function () { throw new RangeError('Locale unavailable'); } });
    Object.defineProperty(Date.prototype, 'toLocaleString', { configurable: true, value: function () { throw new Error('Locale blocked'); } });
  });
  const refresh = page.getByRole('button', { name: 'Refresh devices', exact: true });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('pair.list'))).toBe(2);
  await expect(refresh).toHaveText('Refresh');
  await expect(refresh).toBeFocused();
  await expect(checked).toHaveText('Last successful check: Unknown time');
  await expect(checked.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expect(page.locator('.account-devices-row')).toHaveCount(3);
});

test('Settings Devices Refresh recovers an initial failed check without a fabricated time', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?devices=fail-once-slow-retry`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));
  await expect(page.locator('[data-error="list"]')).toBeVisible();
  const checked = page.locator('[data-devices-last-checked]');
  await expect(checked).toHaveText('Not checked yet');
  await expect(checked.locator('time')).toHaveCount(0);
  await page.evaluate(() => window.__app.holdRpcResponses?.('pair.list'));
  const refresh = page.getByRole('button', { name: 'Refresh devices', exact: true });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await expect(refresh).toHaveText('Refreshing…');
  await expect(refresh).toBeFocused();
  await expect(checked).toHaveText('Not checked yet');
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list'))).toBe(1);
  await expect(refresh).toHaveText('Refresh');
  await expect(refresh).toBeFocused();
  await expect(checked.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expect(page.locator('.account-devices-row')).toHaveCount(3);
  await expect(page.locator('[data-error="list"]')).toHaveCount(0);
});

test('Settings Devices manual checks preserve a pending revoke through its latest roster', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?devices=ready&device_revoke_response=slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));
  const laptop = page.locator('.account-devices-row[data-instance-id="device-laptop"]');
  await laptop.locator('[data-action="revoke-device"]').click();
  await page.evaluate(() => window.__app.holdRpcResponses?.('pair.list'));
  await page.locator('[data-action="confirm-revoke"][data-instance-id="device-laptop"]').focus();
  await page.keyboard.press('Enter');
  const refresh = page.getByRole('button', { name: 'Refresh devices', exact: true });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await expect(refresh).toHaveText('Refreshing…');
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('pair.list'))).toBe(3);
  await page.evaluate(() => {
    window.confirm = (message?: string): boolean => {
      document.documentElement.setAttribute('data-device-leave-prompt', message ?? '');
      return false;
    };
    window.__app.setHash('#chat');
  });
  await expect(page.locator('html')).toHaveAttribute('data-device-leave-prompt',
    'Recued is still shutting a device out. Leave Settings anyway?');
  await expect(page).toHaveURL(/#settings\/devices$/);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list', 1))).toBe(1);
  await expect(laptop).toHaveCount(0);
  await expect(refresh).toHaveText('Refresh');
  await expect(refresh).toBeFocused();
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('pair.list', 0))).toBe(1);
  await expect(laptop).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('pair.revoke'))).toBe(1);
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
});

test('Settings Devices Retry owns recovery and advances into the roster', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?devices=fail-once-slow-retry`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));

  const retry = page.locator('[data-action="retry-list"]');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('pair.list')),
  ).toBe(2);

  await expect(retry).toHaveCount(0);
  await expect(page.locator(
    '[data-action="revoke-device"][data-instance-id="device-laptop"]',
  )).toBeFocused();
});

test('Settings Devices returns a failed roster Retry to its alert action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?devices=fail-twice-slow-retry`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));

  const retry = page.locator('[data-action="retry-list"]');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');

  await expect(retry).toHaveText('Retry');
  await expect(retry).not.toHaveAttribute('aria-disabled');
  await expect(retry).not.toHaveAttribute('aria-busy');
  await expect(retry).toBeFocused();
  await expect(page.locator('[data-error="list"]')).toHaveAttribute(
    'role',
    'alert',
  );
});

// D-269 retired the Bridge row's CHANNEL switch (it decided nothing), and the
// two tests that drove it went with it. Their contracts live on in the
// per-browser twins below: mutation ownership, and failures that return to
// the exact control.
test('Settings keeps a pending notification write attached on route leave', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?notifications=ready&notifications_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  // D-269 — the per-device switch: the Bridge row's channel switch is gone,
  // and a pending per-device write must hold the route exactly as it did.
  const toggle = page.getByRole('switch', {
    name: 'Main browser notifications (bridge-main)',
    exact: true,
  });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveText('Updating…');

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    window.__app.setHash('#chat');
  });

  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A notification setting is still updating. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/notifications$/);
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveText('Notifications On');

  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings per-browser notification switches retain mutation ownership', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?notifications=ready&notifications_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  const toggle = page.getByRole('switch', {
    name: 'Main browser notifications (bridge-main)',
    exact: true,
  });
  await expect(toggle).toHaveText('Notifications Off');
  await toggle.focus();
  await page.keyboard.press('Enter');

  await expect(toggle).toHaveText('Updating…');
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).not.toHaveAttribute('disabled');
  await expect(toggle).toBeFocused();
  await toggle.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('notifications.set_bridge_mode')),
  ).toBe(1);

  await expect(toggle).toHaveText('Notifications On');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).not.toHaveAttribute('aria-disabled');
  await expect(toggle).not.toHaveAttribute('aria-busy');
  await expect(toggle).toBeFocused();
});

test('Settings per-browser switch failures return to the exact control', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?notifications=ready&notifications_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  const toggle = page.locator(
    '[data-recued-notifications-bridge-mode-btn="bridge-main"]'
      + '[data-recued-notifications-bridge-mode="notification"]',
  );
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveText('Updating…');
  await expect(toggle).toBeFocused();

  await expect(page.getByRole('alert'))
    .toContainText('Browser notification setting unavailable.');
  await expect(toggle).toHaveText('Notifications Off');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).not.toHaveAttribute('aria-disabled');
  await expect(toggle).not.toHaveAttribute('aria-busy');
  await expect(toggle).toBeFocused();
});

test('Settings notification phrase Save retains mutation ownership', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?notifications=ready&notifications_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  await expect(page.getByRole('heading', {
    name: 'Your secret phrase',
    level: 3,
  })).toBeVisible();
  const input = page.getByRole('textbox', {
    name: 'Your secret phrase',
    exact: true,
  });
  const save = page.getByRole('button', {
    name: 'Save your secret phrase',
    exact: true,
  });
  await input.fill('green fox');
  await save.focus();
  await page.keyboard.press('Enter');

  await expect(input).toHaveValue('green fox');
  await expect(input).toBeDisabled();
  await expect(save).toHaveText('Saving…');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  await save.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => (
      window.__app.rpcCallCount('notifications.set_verification_phrase')
    )),
  ).toBe(1);

  await expect(input).toHaveValue('green fox');
  await expect(input).not.toBeDisabled();
  await expect(save).toHaveText('Save');
  await expect(save).not.toHaveAttribute('aria-disabled');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).toBeFocused();
});

test('Settings notification phrase failures retain the draft and Save', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?notifications=ready&notifications_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  const input = page.locator('[data-recued-notifications-phrase-input]');
  const save = page.locator('[data-recued-notifications-phrase-save]');
  await input.fill('green fox');
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(save).toHaveText('Saving…');
  await expect(save).toBeFocused();

  await expect(page.getByRole('alert').filter({
    hasText: 'Verification phrase unavailable.',
  })).toBeVisible();
  await expect(input).toHaveValue('green fox');
  await expect(input).not.toBeDisabled();
  await expect(save).toHaveText('Save');
  await expect(save).not.toHaveAttribute('aria-disabled');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).toBeFocused();
});

test('Settings guards an unsaved notification phrase until it is reverted', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?notifications=ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  const input = page.locator('[data-recued-notifications-phrase-input]');
  await expect(input).toHaveValue('blue lantern');
  await input.fill('unsaved phrase');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    window.__app.setHash('#chat');
  });

  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Discard the unsaved notification verification phrase?',
  );
  await expect(page).toHaveURL(/#settings\/notifications$/);
  await expect(input).toHaveValue('unsaved phrase');

  // Returning exactly to the authoritative value is no longer dirty and
  // should not force a needless confirmation.
  await input.fill('blue lantern');
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings notification Retry owns loading and advances into recovered controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?notifications=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  await expect(page.getByRole('alert'))
    .toContainText('Notification channels unavailable.');
  const describes = () =>
    page.evaluate(() => window.__app.rpcCallCount('notifications.describe'));
  // ⚠ NOT a fixed total. Two panels read this list on load (the channels and,
  // since D-269, "What you are notified about"), so the failed load alone is
  // two reads. Single-flight is the claim: Retry adds exactly ONE read.
  await expect.poll(describes).toBeGreaterThan(0);
  const beforeRetry = await describes();
  const retry = page.locator('[data-recued-notifications-retry]');
  await retry.focus();
  await page.keyboard.press('Enter');

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(describes).toBe(beforeRetry + 1);

  await expect(retry).toHaveCount(0);
  // D-269 — the Bridge row has no channel switch any more; its per-device
  // switches are the first recovered control, and Retry advances into them.
  const firstSwitch = page.getByRole('switch', {
    name: 'Main browser notifications (bridge-main)',
    exact: true,
  });
  await expect(firstSwitch).toHaveText('Notifications Off');
  await expect(firstSwitch).toBeFocused();
});

test('Settings Server tabs form one full-size arrow-key keyboard stop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#settings/server'));

  const tabs = page.locator(`[${SETTINGS_SUBTAB}]`);
  // D-272 — Connect a device comes FIRST (the beginner's question), and the
  // Reachability tab is gone, folded into it. The keyboard contract this test
  // is about did not change; only the tabs it walks did.
  const connect = page.locator(`[${SETTINGS_SUBTAB}="connect-device"]`);
  const exposure = page.locator(`[${SETTINGS_SUBTAB}="exposure"]`);
  const maintenance = page.locator(`[${SETTINGS_SUBTAB}="maintenance"]`);
  await expect(page.getByRole('tablist', {
    name: 'Server sections',
  })).toBeVisible();
  await expect(connect).toHaveAttribute('tabindex', '0');
  expect(await tabs.evaluateAll((nodes) => nodes.filter(
    (node) => node.getAttribute('tabindex') === '0',
  ).length)).toBe(1);
  const tabHeights = await tabs.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height)
  );
  expect(Math.min(...tabHeights)).toBeGreaterThanOrEqual(36);

  await connect.focus();
  await page.keyboard.press('ArrowRight');
  await expect(exposure).toHaveAttribute('aria-selected', 'true');
  await expect(exposure).toHaveAttribute('tabindex', '0');
  await expect(exposure).toBeFocused();

  await page.keyboard.press('End');
  await expect(maintenance).toHaveAttribute('aria-selected', 'true');
  await expect(maintenance).toBeFocused();
  await page.keyboard.press('Home');
  await expect(connect).toHaveAttribute('aria-selected', 'true');
  await expect(connect).toBeFocused();
});

test('Settings Exposure confirmations own keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1#settings/server/exposure`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const cellInputs = page.locator('.exposure-cell-checkbox');
  const cellTargets = page.locator('.exposure-cell-target');
  const cellCount = await cellInputs.count();
  expect(cellCount).toBeGreaterThan(0);
  await expect(cellTargets).toHaveCount(cellCount);
  for (let index = 0; index < await cellTargets.count(); index += 1) {
    const box = await cellTargets.nth(index).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(36);
    expect(box?.height).toBeGreaterThanOrEqual(36);
  }
  await expect(page.locator('html')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('html').evaluate((element) => element.clientWidth),
  );

  const trigger = page.locator(`[${EXPOSURE_PUBLIC_MCP}]`);
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: 'Let AI apps in from outside?' });
  const phrase = dialog.getByRole('textbox', {
    name: 'Type "enable public MCP" to confirm',
  });
  const cancel = dialog.locator(`[${EXPOSURE_MODAL_CANCEL}]`);
  const submit = dialog.locator(`[${EXPOSURE_MODAL_SUBMIT}]`);
  await expect(dialog).toBeVisible();
  await expect(phrase).toBeFocused();

  // Every keystroke replaces the modal DOM from its state machine. Focus and
  // the caret must follow the replacement input instead of dropping to body.
  await page.keyboard.type('enable public MCP');
  await expect(phrase).toHaveValue('enable public MCP');
  await expect(phrase).toBeFocused();
  await expect(submit).toBeEnabled();

  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(submit).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(phrase).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(submit).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  const wsTrigger = page.locator(`[${EXPOSURE_CELL}="ws.lan"]`);
  await wsTrigger.click();
  const wsDialog = page.getByRole('dialog', {
    name: 'Cut this browser off?',
  });
  await expect(wsDialog.getByRole('textbox', {
    name: 'Type "disconnect webclients" to confirm',
  })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(wsDialog).toHaveCount(0);
  await expect(wsTrigger).toBeFocused();
});

for (const width of [390, 1280]) {
  for (const activation of ['keyboard', 'pointer'] as const) {
    for (const correction of ['append', 'replace', 'backspace'] as const) {
      test(`Settings Server address keeps ${correction} typing after refusal via ${activation} at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const { row, input, edit, original } = await openServerAddressEditor(page, activation);
        const value = 'not-a-server.old';
        await input.fill('not-a-server');
        await input.press('End'); await page.keyboard.type('.old', { delay: 30 });
        await expect(input).toHaveValue(value);
        const check = row.locator('[data-server-address-check]');
        await check.focus(); await page.keyboard.press('Enter');
        await expect(row).toHaveAttribute('data-server-address-row-state', 'refused');
        await expect(input).toBeFocused();
        await expect(row.locator('[data-server-address-save]')).toHaveCount(0);
        let wanted: string;
        let caret: number;
        if (correction === 'replace') {
          await input.evaluate(node => (node as HTMLInputElement).setSelectionRange(4, 5, 'backward'));
          await page.keyboard.type('fixed', { delay: 30 });
          wanted = `${value.slice(0, 4)}fixed${value.slice(5)}`; caret = 9;
        } else if (correction === 'backspace') {
          await input.press('End');
          for (let index = 0; index < 3; index++) await page.keyboard.press('Backspace');
          wanted = value.slice(0, -3); caret = wanted.length;
        } else {
          await input.press('End'); await page.keyboard.type('.new', { delay: 30 });
          wanted = `${value}.new`; caret = wanted.length;
        }
        await expect(input).toHaveValue(wanted);
        await expect(input).toBeFocused();
        expect(await input.evaluate(node => [(node as HTMLInputElement).selectionStart, (node as HTMLInputElement).selectionEnd])).toEqual([caret, caret]);
        await expect(row).toHaveAttribute('data-server-address-row-state', 'editing');
        await expect(row.locator('[data-server-address-status]')).toBeEmpty();
        const cancel = row.locator('[data-server-address-cancel]');
        await cancel.focus(); await page.keyboard.press('Enter');
        await expect(edit).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(input).toBeFocused();
        await expect(input).toHaveValue(original);
      });
    }
  }

  for (const outcome of ['mismatch', 'unreachable'] as const) {
    for (const moveAway of [false, true]) {
      test(`Settings Server address ${outcome} check respects ${moveAway ? 'moved' : 'owned'} focus at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const { row, input } = await openServerAddressEditor(page);
        const probe = await holdServerAddressProbe(page);
        await input.fill(probe.candidate);
        const check = row.locator('[data-server-address-check]');
        await check.focus(); await page.keyboard.press('Enter');
        const status = row.locator('[data-server-address-status]');
        await expect(status).toHaveText('Checking…');
        await expect(status).toBeFocused();
        await expect(input).toBeDisabled();
        const outside = page.locator('[data-recued-account-menu-trigger]');
        if (moveAway) await outside.focus();
        await probe.release(outcome);
        await expect(row).toHaveAttribute('data-server-address-row-state', 'refused');
        await expect(status).toContainText(outcome === 'unreachable' ? 'Nothing answered' : 'could not prove');
        await expect(row.locator('[data-server-address-save]')).toHaveCount(0);
        if (moveAway) await expect(outside).toBeFocused();
        else await expect(input).toBeFocused();
        expect(probe.state.requests).toBe(1);
      });
    }
  }

  test(`Settings Server address Cancel returns keyboard focus before checking at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { row, input, edit } = await openServerAddressEditor(page);
    await input.fill('a draft address');
    await row.locator('[data-server-address-cancel]').focus(); await page.keyboard.press('Enter');
    await expect(row).toHaveAttribute('data-server-address-row-state', 'idle');
    await expect(edit).toBeFocused();
  });
}

for (const direction of ['forward', 'backward'] as const) {
  test(`Settings Server address preserves a ${direction} selection across invalidation`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { row, input } = await openServerAddressEditor(page);
    await input.fill('not-a-server.old');
    await row.locator('[data-server-address-check]').focus(); await page.keyboard.press('Enter');
    await expect(row).toHaveAttribute('data-server-address-row-state', 'refused');
    await input.evaluate((node, direction) => {
      const input = node as HTMLInputElement;
      input.setSelectionRange(2, 8, direction);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, direction);
    await expect(row).toHaveAttribute('data-server-address-row-state', 'editing');
    await expect(input).toBeFocused();
    expect(await input.evaluate(node => {
      const input = node as HTMLInputElement;
      return [input.selectionStart, input.selectionEnd, input.selectionDirection];
    })).toEqual([2, 8, direction]);
  });
}

test('Settings Server address scripted actions respect outside focus', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.__app.setHash('#settings/servers'));
  const row = page.locator('[data-server-address-row]').first();
  const outside = page.locator('[data-recued-account-menu-trigger]');
  await outside.focus();
  await row.locator('[data-server-address-edit]').evaluate(node => (node as HTMLButtonElement).click());
  await expect(outside).toBeFocused();
  await row.locator('[data-server-address-input]').fill('not-a-server');
  await outside.focus();
  await row.locator('[data-server-address-check]').evaluate(node => (node as HTMLButtonElement).click());
  await expect(row).toHaveAttribute('data-server-address-row-state', 'refused');
  await expect(outside).toBeFocused();
});

test('Settings Server address focus follows the selected profile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?server_profiles=multiple#settings/servers`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const rows = page.locator('[data-server-address-row]');
  await expect(rows).toHaveCount(2);
  for (const index of [0, 1]) {
    await rows.nth(index).locator('[data-server-address-edit]').focus(); await page.keyboard.press('Enter');
    await expect(rows.nth(index).locator('[data-server-address-input]')).toBeFocused();
  }
  await expect(rows.nth(0)).toHaveAttribute('data-server-address-row-state', 'idle');
  await rows.nth(1).locator('[data-server-address-input]').fill('not-a-server');
  await rows.nth(1).locator('[data-server-address-cancel]').focus(); await page.keyboard.press('Enter');
  await expect(rows.nth(1).locator('[data-server-address-edit]')).toBeFocused();
});

test('Settings Server address Cancel retires a pending check’s focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { row, input, edit } = await openServerAddressEditor(page);
  const probe = await holdServerAddressProbe(page);
  await input.fill(probe.candidate);
  await row.locator('[data-server-address-check]').focus(); await page.keyboard.press('Enter');
  await expect(row.locator('[data-server-address-status]')).toBeFocused();
  await row.locator('[data-server-address-cancel]').focus(); await page.keyboard.press('Enter');
  await expect(edit).toBeFocused();
  await probe.release('mismatch');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(row).toHaveAttribute('data-server-address-row-state', 'idle');
  await expect(edit).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
});

test.describe('Settings Exposure keyboard navigation', () => {
  const flows = [
    {
      name: 'MCP consent', trigger: `[${EXPOSURE_PUBLIC_MCP}]`, key: 'Enter',
      title: 'Let AI apps in from outside?', phrase: 'enable public MCP',
      method: 'exposure.set_public_mcp_acknowledgement',
    },
    {
      name: 'MCP revocation', trigger: `[${EXPOSURE_PUBLIC_MCP}]`, key: 'Enter',
      title: 'Shut AI apps out again?', phrase: '',
      method: 'exposure.set_public_mcp_acknowledgement',
    },
    {
      name: 'WebSocket path lockout', trigger: `[${EXPOSURE_CELL}="ws.lan"]`, key: 'Space',
      title: 'Cut this browser off?', phrase: 'disconnect webclients',
      method: 'exposure.set_path_resolution',
    },
    {
      name: 'maintenance lockout', trigger: '[data-recued-exposure-preset="maintenance"] input', key: 'Space',
      title: 'Cut this browser off?', phrase: 'disconnect webclients',
      method: 'exposure.apply_preset',
    },
  ] as const;

  const openConfirmation = async (page: Page, flow: typeof flows[number], width: number) => {
    await page.setViewportSize({ width, height: 900 });
    const acknowledged = flow.name === 'MCP revocation' ? '&exposure=acknowledged' : '';
    await page.goto(`${HARNESS_URL}?settle_reads=1&exposure_write=refuse${acknowledged}#settings/server/exposure`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const trigger = page.locator(flow.trigger);
    await trigger.focus();
    await page.keyboard.press(flow.key);
    const dialog = page.getByRole('dialog', { name: flow.title, exact: true });
    await expect(dialog).toBeVisible();
    return {
      dialog, trigger,
      phrase: dialog.getByRole('textbox'),
      cancel: dialog.locator(`[${EXPOSURE_MODAL_CANCEL}]`),
      submit: dialog.locator(`[${EXPOSURE_MODAL_SUBMIT}]`),
    };
  };

  const followTabs = async (page: Page, key: 'Tab' | 'Shift+Tab', stops: Locator[]) => {
    for (const stop of stops) {
      await page.keyboard.press(key);
      await expect(stop).toBeFocused();
    }
  };

  for (const width of [390, 1280]) {
    for (const flow of flows) {
      test(`${flow.name} visits every enabled control in both directions at ${width}px`, async ({ page }) => {
        const { dialog, trigger, phrase, cancel, submit } = await openConfirmation(page, flow, width);
        if (flow.phrase) {
          await expect(phrase).toBeFocused();
          for (const value of ['', 'wrong phrase']) {
            if (value) await page.keyboard.type(value);
            await expect(phrase).toHaveValue(value);
            await expect(submit).toBeDisabled();
            await followTabs(page, 'Tab', [cancel, phrase, cancel, phrase]);
            await followTabs(page, 'Shift+Tab', [cancel, phrase]);
          }
          await page.keyboard.press('ControlOrMeta+A');
          await page.keyboard.type(flow.phrase);
          await expect(phrase).toHaveValue(flow.phrase);
          await expect(submit).toBeEnabled();
          await followTabs(page, 'Tab', [cancel, submit, phrase]);
          await followTabs(page, 'Shift+Tab', [submit, cancel, phrase]);
        } else {
          await expect(phrase).toHaveCount(0);
          await expect(cancel).toBeFocused();
          await followTabs(page, 'Tab', [submit, cancel, submit, cancel]);
          await followTabs(page, 'Shift+Tab', [submit, cancel]);
        }
        // Re-enter the cycle when the dialog container itself owns focus.
        await dialog.focus();
        await followTabs(page, 'Tab', [flow.phrase ? phrase : cancel]);
        await dialog.focus();
        await followTabs(page, 'Shift+Tab', [submit]);
        await cancel.focus();
        await page.keyboard.press('Enter');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
        expect(await page.evaluate(method => window.__app.rpcCallCount(method), flow.method)).toBe(0);
      });

      test(`${flow.name} contains focus while submitting and after refusal at ${width}px`, async ({ page }) => {
        const { dialog, trigger, phrase, cancel, submit } = await openConfirmation(page, flow, width);
        await page.evaluate(method => window.__app.holdRpcResponses?.(method), flow.method);
        if (flow.phrase) await phrase.fill(flow.phrase);
        await submit.focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => page.evaluate(method => window.__app.rpcCallCount(method), flow.method)).toBe(1);
        await expect(dialog).toHaveAttribute('aria-busy', 'true');
        await expect(dialog).toBeFocused();
        await expect(cancel).toBeDisabled();
        await expect(submit).toBeDisabled();
        if (flow.phrase) await expect(phrase).toBeDisabled();
        await followTabs(page, 'Tab', [dialog, dialog]);
        await followTabs(page, 'Shift+Tab', [dialog, dialog]);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Enter');
        await expect(dialog).toHaveAttribute('aria-busy', 'true');
        await expect(dialog).toBeFocused();
        expect(await page.evaluate(method => window.__app.rpcCallCount(method), flow.method)).toBe(1);
        expect(await page.evaluate(method => window.__app.releaseRpcResponses?.(method), flow.method)).toBe(1);
        await expect(dialog.getByRole('alert')).toBeVisible();
        await expect(dialog).not.toHaveAttribute('aria-busy');
        if (flow.phrase) {
          await expect(phrase).toBeFocused();
          await expect(submit).toBeDisabled();
          await followTabs(page, 'Tab', [cancel, phrase]);
          await followTabs(page, 'Shift+Tab', [cancel, phrase]);
          await phrase.fill(flow.phrase);
          await expect(submit).toBeEnabled();
          await followTabs(page, 'Tab', [cancel, submit, phrase]);
          await followTabs(page, 'Shift+Tab', [submit, cancel, phrase]);
        } else {
          await expect(cancel).toBeFocused();
          await followTabs(page, 'Tab', [submit, cancel]);
          await followTabs(page, 'Shift+Tab', [submit, cancel]);
        }
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
        expect(await page.evaluate(method => window.__app.rpcCallCount(method), flow.method)).toBe(1);
      });
    }
  }
});

test.describe('Settings Exposure connection example', () => {
  const examples = [
    ['claude', 'Claude Desktop'], ['cursor', 'Cursor'],
    ['codex', 'Codex'], ['custom', 'Another AI app'],
  ] as const;

  const openExample = async (page: Page, width: number, activation: 'keyboard' | 'pointer' = 'keyboard') => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(`${HARNESS_URL}?settle_reads=1#settings/server/exposure`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const trigger = page.locator('[data-recued-exposure-connect-example]');
    if (activation === 'keyboard') {
      await trigger.focus();
      await page.keyboard.press('Enter');
    } else await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Connect an AI app to this server', exact: true });
    await expect(dialog).toBeFocused();
    return {
      trigger, dialog,
      card: dialog.locator('.exposure-modal-card'),
      snippets: examples.map(([, label]) => dialog.getByRole('region', { name: label, exact: true })),
      close: dialog.getByRole('button', { name: 'Close', exact: true }),
    };
  };

  const expectNoExposureWrites = async (page: Page) => {
    expect(await page.evaluate(() => [
      'exposure.set_public_mcp_acknowledgement', 'exposure.set_path_resolution',
      'exposure.apply_preset', 'exposure.set_apex',
    ].map(method => window.__app.rpcCallCount(method)))).toEqual([0, 0, 0, 0]);
  };

  for (const width of [390, 1280]) {
    for (const activation of ['keyboard', 'pointer'] as const) {
      for (const dismissal of ['Escape', 'Enter', 'pointer'] as const) {
        test(`keeps examples reachable and returns focus via ${dismissal} after ${activation} entry at ${width}px`, async ({ page }) => {
          const { trigger, dialog, card, snippets, close } = await openExample(page, width, activation);
          await expect(dialog.getByRole('heading', { name: 'Connect an AI app to this server' })).toBeInViewport({ ratio: 1 });
          const box = await card.boundingBox();
          expect(box?.y).toBeGreaterThanOrEqual(0);
          expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(page.viewportSize()!.height);
          for (const [index, snippet] of snippets.entries()) {
            await expect(snippet).toHaveAttribute('data-recued-exposure-connect-snippet', examples[index]![0]);
            await expect(snippet).toHaveAttribute('tabindex', '0');
            await expect(snippet).toContainText('/mcp');
            await page.keyboard.press('Tab');
            await expect(snippet).toBeFocused();
            await expect(snippet).toBeInViewport({ ratio: 1 });
          }
          await page.keyboard.press('Tab');
          await expect(close).toBeFocused();
          await expect(close).toBeInViewport({ ratio: 1 });
          await page.keyboard.press('Tab');
          await expect(snippets[0]).toBeFocused();
          for (const stop of [close, ...[...snippets].reverse()]) {
            await page.keyboard.press('Shift+Tab');
            await expect(stop).toBeFocused();
            await expect(stop).toBeInViewport({ ratio: 1 });
          }
          // Plain arrows scroll the focused code example on both engines.
          if (await snippets[0].evaluate(node => node.scrollWidth > node.clientWidth)) {
            await snippets[0].evaluate(node => { node.scrollLeft = 0; });
            await page.keyboard.press('ArrowRight');
            await expect.poll(() => snippets[0].evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
            const right = await snippets[0].evaluate(node => node.scrollLeft);
            await page.keyboard.press('ArrowLeft');
            await expect.poll(() => snippets[0].evaluate(node => node.scrollLeft)).toBeLessThan(right);
            await expect(snippets[0]).toBeFocused();
          }
          expect(await snippets[0].evaluate(node => ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].map(modifier => {
            const event = new KeyboardEvent('keydown', { key: 'ArrowRight', [modifier]: true, bubbles: true, cancelable: true });
            node.dispatchEvent(event);
            return event.defaultPrevented;
          }))).toEqual([false, false, false, false]);
          if (dismissal === 'Escape') await page.keyboard.press('Escape');
          else if (dismissal === 'pointer') await close.click();
          else {
            await page.keyboard.press('Shift+Tab');
            await expect(close).toBeFocused();
            await page.keyboard.press('Enter');
          }
          await expect(dialog).toHaveCount(0);
          await expect(trigger).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(dialog).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(dialog).toHaveCount(0);
          await expect(trigger).toBeFocused();
          await expectNoExposureWrites(page);
        });
      }
    }

    for (const owner of ['dialog', 'snippet', 'close', 'outside'] as const) {
      test(`preserves ${owner} focus across a background redraw at ${width}px`, async ({ page }) => {
        const { trigger, dialog, card, snippets, close } = await openExample(page, width);
        const target = owner === 'dialog' ? dialog : owner === 'snippet' ? snippets[3]
          : owner === 'close' ? close : page.locator('[data-recued-account-menu-trigger]');
        await target.focus();
        if (owner === 'snippet') await target.evaluate(node => { node.scrollLeft = 40; });
        const top = await card.evaluate(node => node.scrollTop);
        const left = await target.evaluate(node => node.scrollLeft);
        const prior = await dialog.elementHandle();
        if (!prior) throw new Error('The example dialog did not mount.');
        await page.evaluate(event => window.__app.fireMessage({ type: 'server_event', event }), {
          kind: 'exposure_changed', resolution: applyPreset('lan_only', { acknowledged: false }),
          derived_preset_label: 'lan_only', public_mcp_acknowledgement: { acknowledged: false },
          changed_at: 1_700_000_000_001, changed_by_client_id: 'device-other',
        });
        await expect.poll(() => prior.evaluate(node => !node.isConnected)).toBe(true);
        await expect(target).toBeFocused();
        expect(await card.evaluate(node => node.scrollTop)).toBeCloseTo(top, 0);
        expect(await target.evaluate(node => node.scrollLeft)).toBeCloseTo(left, 0);
        await close.click();
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await expectNoExposureWrites(page);
      });
    }

    test(`keeps the next confirmation's own return target at ${width}px`, async ({ page }) => {
      const { dialog, trigger } = await openExample(page, width);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      const consentTrigger = page.locator(`[${EXPOSURE_PUBLIC_MCP}]`);
      await consentTrigger.focus();
      await page.keyboard.press('Enter');
      const consent = page.getByRole('dialog', { name: 'Let AI apps in from outside?', exact: true });
      await expect(consent.getByRole('textbox')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(consent).toHaveCount(0);
      await expect(consentTrigger).toBeFocused();
      await expectNoExposureWrites(page);
    });
  }
});

const tzRecoveryCheck = (page: Page) => tzNavPanel(page).getByRole('button', { name: 'Check saved timezone', exact: true });
const tzRecoveryPending = (page: Page) => tzNavPanel(page).getByRole('status').filter({ hasText: 'Checking saved timezone…' });
const openTimezoneRecovery = async (page: Page, width: number, applied = true) => {
  await openTimezoneNav(page, width);
  await page.evaluate(applied => {
    window.__timezoneNavigation.failNextSave = !applied; window.__timezoneNavigation.loseNextSaveReply = applied;
  }, applied);
  await tzNavZone(page).fill('Asia/Tokyo'); await tzNavZone(page).press('Enter');
  await expect(tzNavPanel(page).getByRole('alert')).toHaveText('Timezone save failed. Try again.');
  await expect(tzRecoveryCheck(page)).toBeVisible();
};

for (const width of [390, 1280]) {
  test(`Server timezone recovery protects a pending check through canceled navigation and reload at ${width}px`, async ({ page }) => {
    await openTimezoneRecovery(page, width, false); await tzNavZone(page).fill('Europe/London');
    const before = await page.evaluate(() => window.__timezoneNavigation.reads);
    await page.evaluate(() => window.__app.holdRpcResponses?.('server.timezone.get')); await tzRecoveryCheck(page).press('Enter');
    await expect(tzRecoveryPending(page)).toBeFocused(); expect(await tzNavUnloadBlocked(page)).toBe(true);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.type() === 'beforeunload' ? 'beforeunload' : dialog.message()); void dialog.dismiss(); });
    await page.evaluate(() => { location.reload(); }); await expect.poll(() => dialogs).toEqual(['beforeunload']);
    await tzNavLeave(page); await expect.poll(() => dialogs).toEqual(['beforeunload', tzNavDraftPrompt]);
    await expect(page).toHaveURL(/#settings\/server\/timezone$/u); await expect(tzRecoveryPending(page)).toBeFocused();
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('server.timezone.get'))).toBe(1);
    await expect(tzRecoveryCheck(page)).toHaveCount(0); await expect(tzNavZone(page)).toHaveValue('Europe/London'); await expect(tzNavZone(page)).toBeFocused();
    expect(await tzNavUnloadBlocked(page)).toBe(false); await tzNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible();
    expect(dialogs).toEqual(['beforeunload', tzNavDraftPrompt]); expect(await tzNavWrites(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }]);
    expect(await page.evaluate(() => window.__timezoneNavigation.reads)).toBe(before + 1);
  });

  test(`Server timezone recovery confirms an applied save and clears its departure warning at ${width}px`, async ({ page }) => {
    await openTimezoneRecovery(page, width); const before = await page.evaluate(() => window.__timezoneNavigation.reads);
    await page.evaluate(() => window.__app.holdRpcResponses?.('server.timezone.get')); await tzRecoveryCheck(page).press('Enter');
    await expect(tzRecoveryPending(page)).toBeFocused(); expect(await tzNavUnloadBlocked(page)).toBe(true);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('server.timezone.get'))).toBe(1);
    await expect(tzNavPanel(page).getByText('Saved as Asia/Tokyo.', { exact: true })).toBeVisible(); await expect(tzNavZone(page)).toBeFocused();
    expect(await tzNavUnloadBlocked(page)).toBe(false); await expect(tzRecoveryCheck(page)).toHaveCount(0);
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await tzNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([]);
    expect(await tzNavWrites(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }]);
    expect(await page.evaluate(() => window.__timezoneNavigation.reads)).toBe(before + 1);
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`Server timezone recovery ignores a late check ${outcome} after accepted departure at ${width}px`, async ({ page }) => {
      await openTimezoneRecovery(page, width);
      await page.evaluate(fail => {
        window.__timezoneNavigation.failNextRead = fail; window.__app.holdRpcResponses?.('server.timezone.get');
      }, outcome === 'error');
      await tzRecoveryCheck(page).press('Enter'); await expect(tzRecoveryPending(page)).toBeFocused();
      const old = await tzNavPanel(page).elementHandle(), dialogs: string[] = []; let accept = true;
      page.on('dialog', dialog => { dialogs.push(dialog.message()); void (accept ? dialog.accept() : dialog.dismiss()); });
      await tzNavLeave(page); await expect(page.locator('[data-recued-yours]')).toBeVisible(); expect(dialogs).toEqual([tzNavDraftPrompt]);
      expect(await old!.evaluate(panel => panel.isConnected)).toBe(false);
      const before = await page.evaluate(() => window.__timezoneNavigation.reads);
      await page.evaluate(() => window.__app.setHash('#settings/server/timezone'));
      await expect.poll(() => page.evaluate(() => window.__timezoneNavigation.reads)).toBe(before + 1);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('server.timezone.get', 1))).toBe(1);
      await expect(tzNavZone(page)).toHaveValue('Asia/Tokyo'); await tzNavZone(page).fill('  Pacific/Auckland  ');
      await tzNavZone(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(3, 9, 'backward'));
      const fresh = await tzNavZone(page).elementHandle();
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('server.timezone.get', 0))).toBe(1);
      await expect(tzNavZone(page)).toHaveValue('  Pacific/Auckland  '); await expect(tzNavZone(page)).toBeFocused();
      expect(await fresh!.evaluate(input => input.isConnected && input === document.activeElement)).toBe(true);
      expect(await tzNavZone(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([3, 9, 'backward']);
      await expect(tzNavPanel(page).getByRole('alert')).toHaveCount(0); await expect(tzRecoveryCheck(page)).toHaveCount(0);
      accept = false; await tzNavLeave(page); await expect.poll(() => dialogs).toEqual([tzNavDraftPrompt, tzNavDraftPrompt]);
      expect(await tzNavWrites(page)).toEqual([{ mode: 'fixed', zone: 'Asia/Tokyo' }]);
    });
  }
}
