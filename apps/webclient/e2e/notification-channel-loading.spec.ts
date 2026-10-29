import { expect, test, type Page } from '@playwright/test';
import type { NotificationBridgeRow, NotificationChannelToggleView, NotificationSettingsRow } from '@recued/contracts';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';

const BASE = `${HARNESS_ORIGIN}/full-app-harness.html?notifications=ready`;
const panel = (page: Page) => page.locator('[data-recued-notifications-panel]');
const phrase = (page: Page) => panel(page).locator('[data-recued-notifications-phrase-input]');
const loading = (page: Page) => panel(page).locator('[data-recued-notifications-bridge-loading]');
const retry = (page: Page) => panel(page).locator('[data-recued-notifications-bridge-retry]');
type Reply = { result?: unknown; error?: { code: string; message: string } };
interface LoadingFixture {
  mode: 'hold' | 'error' | 'ready';
  channelFailure: boolean;
  channelReads: number;
  deviceReads: number;
  writes: string[];
  devices: NotificationBridgeRow[];
  savedPhrase: string;
  slackEnabled: boolean;
  holdDeviceWrites: boolean;
  input?: HTMLInputElement;
  release(index: number, outcome?: 'ready' | 'error'): void;
  releaseWrite(index: number): void;
}
declare global { interface Window { __notificationLoading: LoadingFixture } }

let errors: string[] = [], interruptions: string[] = [];
test.beforeEach(({ page }) => {
  errors = []; interruptions = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { interruptions.push(dialog.type()); void dialog.dismiss(); });
  page.on('popup', popup => { interruptions.push('popup'); void popup.close(); });
});
test.afterEach(() => { expect(errors).toEqual([]); expect(interruptions).toEqual([]); });

const boot = async (page: Page, mode: LoadingFixture['mode'] = 'hold', channelFailure = false) => {
  await page.goto(`${BASE}#chat`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(({ mode, channelFailure }) => {
    const pending: Array<{ snapshot: NotificationBridgeRow[]; settle(reply: Reply): void; released: boolean }> = [];
    const pendingWrites: Array<{ reply: Reply; settle(reply: Reply): void; released: boolean }> = [];
    const unavailable = { error: { code: 'UNAVAILABLE', message: 'Device list temporarily unavailable.' } };
    const fixture: LoadingFixture = {
      mode, channelFailure, channelReads: 0, deviceReads: 0, writes: [], savedPhrase: 'Saved phrase', slackEnabled: false, holdDeviceWrites: false,
      devices: [{ client_token_id: 'bridge-main', label: 'Main browser', connected: true,
        modes: { notification: true, approval: false } }],
      release(index, outcome = 'ready') {
        const item = pending[index];
        if (!item || item.released) throw new Error(`No pending device read ${index}`);
        item.released = true;
        item.settle(outcome === 'error' ? unavailable : { result: { rows: item.snapshot } });
      },
      releaseWrite(index) {
        const item = pendingWrites[index];
        if (!item || item.released) throw new Error(`No pending device write ${index}`);
        item.released = true; item.settle(item.reply);
      },
    };
    const off = { notification: false, approval: false, messenger: false };
    const settings = (): NotificationSettingsRow => ({ ui: true, bridge: true,
      slack: { ...off, notification: fixture.slackEnabled }, telegram: off, whatsapp: off, discord: off, teams: off, email: off,
      verification_phrase: fixture.savedPhrase,
      bridges: Object.fromEntries(fixture.devices.map(row => [row.client_token_id, row.modes])) });
    Object.assign(window, {
      __notificationLoading: fixture,
      __connectionsFixture: async (method: string, raw: unknown): Promise<Reply | undefined> => {
        if (method === 'notifications.describe') {
          fixture.channelReads++;
          if (fixture.channelFailure) return { error: { code: 'UNAVAILABLE', message: 'Channel settings temporarily unavailable.' } };
          const rows: NotificationChannelToggleView[] = [
            { channel: 'ui', capability: 'inline', ready: true, notification: true, approval: true,
              notification_togglable: false, approval_togglable: false },
            { channel: 'bridge', capability: 'notify-only', ready: true, notification: true, approval: false,
              notification_togglable: true, approval_togglable: false },
            { channel: 'slack', capability: 'inline', ready: true, notification: fixture.slackEnabled, approval: false,
              notification_togglable: true, approval_togglable: true },
            { channel: 'email', capability: 'landing-page', ready: false, notification: false, approval: false,
              notification_togglable: true, approval_togglable: true },
          ];
          return { result: { rows, verification_phrase: fixture.savedPhrase } };
        }
        if (method === 'notifications.describe_bridges') {
          fixture.deviceReads++;
          if (fixture.mode === 'error') return unavailable;
          const snapshot = structuredClone(fixture.devices);
          if (fixture.mode === 'ready') return { result: { rows: snapshot } };
          return new Promise(resolve => { pending.push({ snapshot, settle: resolve, released: false }); });
        }
        if (method === 'notifications.set_channel') {
          fixture.writes.push(method);
          const args = raw as { channel: string; patch: { notification?: boolean } };
          if (args.channel === 'email') return { result: { ok: false, reason: 'not_ready' } };
          if (args.channel === 'slack' && args.patch.notification !== undefined) fixture.slackEnabled = args.patch.notification;
          return { result: { ok: true, settings: settings() } };
        }
        if (method === 'notifications.set_verification_phrase') {
          fixture.writes.push(method);
          fixture.savedPhrase = (raw as { phrase: string | null }).phrase ?? '';
          return { result: { ok: true, settings: settings() } };
        }
        if (method === 'notifications.set_bridge_mode') {
          fixture.writes.push(method);
          const args = raw as { bridge_id: string; patch: Partial<NotificationBridgeRow['modes']> };
          const device = fixture.devices.find(row => row.client_token_id === args.bridge_id);
          if (!device) return { result: { ok: false, reason: 'bridge_unknown', bridge_id: args.bridge_id } };
          device.modes = { ...device.modes, ...args.patch };
          const reply = { result: { ok: true, settings: structuredClone(settings()) } };
          if (fixture.holdDeviceWrites) return new Promise(resolve => { pendingWrites.push({ reply, settle: resolve, released: false }); });
          return reply;
        }
        return undefined;
      },
    });
    window.__app.setHash('#settings/notifications');
  }, { mode, channelFailure });
  await expect(panel(page)).toHaveAttribute('data-recued-notifications-panel-state', channelFailure ? 'error' : 'ready');
};
const keepInput = (page: Page) => phrase(page).evaluate(input => {
  window.__notificationLoading.input = input as HTMLInputElement;
});
const expectInputKept = async (page: Page, value: string) => {
  await expect(phrase(page)).toHaveValue(value);
  expect(await phrase(page).evaluate(input => input === window.__notificationLoading.input && input.isConnected)).toBe(true);
};

test('ready channels remain usable while devices load, and late devices preserve edits and saved choices', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await expect(loading(page)).toBeVisible();
  await expect(panel(page).locator('[data-recued-notifications-bridge-empty]')).toHaveCount(0);
  const slack = panel(page).getByRole('switch', { name: 'Slack notifications', exact: true });
  await slack.click();
  await expect(slack).toHaveAttribute('aria-checked', 'true');
  await phrase(page).fill('Unsaved phrase'); await keepInput(page);
  const reads = await page.evaluate(() => window.__notificationLoading.channelReads);
  await page.screenshot({ path: test.info().outputPath('channels-ready-devices-loading.png'), fullPage: true });
  await page.evaluate(() => window.__notificationLoading.release(0));
  await expect(loading(page)).toHaveCount(0);
  await expect(panel(page).getByText('Main browser', { exact: true })).toBeVisible();
  await expectInputKept(page, 'Unsaved phrase');
  await expect(slack).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => window.__notificationLoading.channelReads)).toBe(reads);
  expect(await page.evaluate(() => window.__notificationLoading.writes)).toEqual(['notifications.set_channel']);
});

test('device-only retry preserves the draft and does not repeat channel reads or writes', async ({ page }) => {
  await boot(page, 'error');
  await expect(retry(page)).toBeVisible();
  await phrase(page).fill('Keep this draft'); await keepInput(page);
  const reads = await page.evaluate(() => window.__notificationLoading.channelReads);
  await page.evaluate(() => { window.__notificationLoading.mode = 'hold'; });
  await retry(page).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(loading(page)).toBeVisible();
  expect(await page.evaluate(() => window.__notificationLoading.deviceReads)).toBe(2);
  await page.evaluate(() => window.__notificationLoading.release(0));
  await expect(retry(page)).toHaveCount(0);
  await expect(panel(page).getByText('Main browser', { exact: true })).toBeVisible();
  await expectInputKept(page, 'Keep this draft');
  expect(await page.evaluate(() => window.__notificationLoading.channelReads)).toBe(reads);
  expect(await page.evaluate(() => window.__notificationLoading.writes)).toEqual([]);
});

test('a newer live device read wins over the held initial read without rebuilding the editor', async ({ page }) => {
  await boot(page);
  await phrase(page).fill('Draft during live update'); await keepInput(page);
  await page.evaluate(() => {
    window.__notificationLoading.devices[0]!.label = 'Updated browser';
    window.__notificationLoading.devices[0]!.modes = { notification: false, approval: true };
    window.__app.fireMessage({ type: 'server_event', event: { kind: 'notification.bridge_mode_changed',
      client_token_id: 'bridge-main', modes: { notification: false, approval: true }, cursor: 1 } });
  });
  await expect.poll(() => page.evaluate(() => window.__notificationLoading.deviceReads)).toBe(2);
  await page.evaluate(() => window.__notificationLoading.release(1));
  await expect(panel(page).getByText('Updated browser', { exact: true })).toBeVisible();
  await page.evaluate(() => window.__notificationLoading.release(0));
  await expect(panel(page).getByRole('switch', { name: 'Updated browser approvals (bridge-main)', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(panel(page).getByText('Main browser', { exact: true })).toHaveCount(0);
  await expectInputKept(page, 'Draft during live update');
  expect(await page.evaluate(() => window.__notificationLoading.writes)).toEqual([]);
});

test('saving the phrase does not wait for devices and a later device failure keeps the confirmed phrase', async ({ page }) => {
  await boot(page);
  await phrase(page).fill('  Confirmed phrase  ');
  await panel(page).getByRole('button', { name: 'Save your secret phrase', exact: true }).click();
  await expect(phrase(page)).toHaveValue('Confirmed phrase');
  await keepInput(page);
  await page.evaluate(() => window.__notificationLoading.release(0, 'error'));
  await expect(retry(page)).toBeVisible();
  await expectInputKept(page, 'Confirmed phrase');
  expect(await page.evaluate(() => window.__notificationLoading.savedPhrase)).toBe('Confirmed phrase');
  expect(await page.evaluate(() => window.__notificationLoading.writes)).toEqual(['notifications.set_verification_phrase']);
});

test('out-of-order device-save replies preserve both confirmed switches and the phrase draft', async ({ page }) => {
  await boot(page, 'ready');
  await phrase(page).fill('Draft during device saves'); await keepInput(page);
  await page.evaluate(() => { window.__notificationLoading.holdDeviceWrites = true; });
  const approval = panel(page).getByRole('switch', { name: 'Main browser approvals (bridge-main)', exact: true });
  const notification = panel(page).getByRole('switch', { name: 'Main browser notifications (bridge-main)', exact: true });
  await approval.click(); await notification.click();
  await expect.poll(() => page.evaluate(() => window.__notificationLoading.writes.length)).toBe(2);
  await page.evaluate(() => window.__notificationLoading.releaseWrite(1));
  await expect(notification).toHaveAttribute('aria-checked', 'false');
  await page.evaluate(() => window.__notificationLoading.releaseWrite(0));
  await expect(approval).not.toHaveAttribute('aria-busy');
  await expect(approval).toHaveAttribute('aria-checked', 'true');
  await expect(notification).toHaveAttribute('aria-checked', 'false');
  await expectInputKept(page, 'Draft during device saves');
  expect(await page.evaluate(() => window.__notificationLoading.deviceReads)).toBe(1);
});

test('device-only reads keep pairing guidance current without replacing channel edits', async ({ page }) => {
  await boot(page, 'error');
  await phrase(page).fill('Draft while devices change'); await keepInput(page);
  const reads = await page.evaluate(() => window.__notificationLoading.channelReads);
  await page.evaluate(() => { window.__notificationLoading.devices = []; window.__notificationLoading.mode = 'ready'; });
  await retry(page).click();
  const card = panel(page).locator('[data-recued-notifications-row-channel="bridge"]');
  await expect(card.locator('[data-recued-notifications-bridge-empty]')).toBeVisible();
  await expect(card).toContainText('Not set up');
  await expect(card.getByText('Per device', { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    window.__notificationLoading.devices = [{ client_token_id: 'new-device', label: 'New browser', connected: true,
      modes: { notification: true, approval: false } }];
    window.__app.fireMessage({ type: 'server_event', event: { kind: 'notification.bridge_mode_changed',
      client_token_id: 'new-device', modes: { notification: true, approval: false }, cursor: 2 } });
  });
  await expect(card.getByRole('switch', { name: 'New browser notifications (new-device)', exact: true })).toBeVisible();
  await expect(card).not.toContainText('Not set up');
  await expect(card.getByText('Per device', { exact: true })).toBeVisible();
  await expectInputKept(page, 'Draft while devices change');
  expect(await page.evaluate(() => window.__notificationLoading.channelReads)).toBe(reads);
  expect(await page.evaluate(() => window.__notificationLoading.writes)).toEqual([]);
});

test('a device response cannot promote a failed channel read into a ready panel', async ({ page }) => {
  await boot(page, 'hold', true);
  await page.evaluate(() => window.__notificationLoading.release(0));
  await expect(panel(page)).toHaveAttribute('data-recued-notifications-panel-state', 'error');
  await expect(phrase(page)).toHaveCount(0);
  await page.evaluate(() => { window.__notificationLoading.channelFailure = false; window.__notificationLoading.mode = 'ready'; });
  await panel(page).locator('[data-recued-notifications-retry]').click();
  await expect(phrase(page)).toHaveValue('Saved phrase');
  await expect(panel(page).getByText('Main browser', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__notificationLoading.writes)).toEqual([]);
});

test('leaving during a device read needs no write confirmation and discards the late response', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(panel(page)).toHaveCount(0);
  await page.evaluate(() => window.__notificationLoading.release(0));
  await expect(page).toHaveURL(/#chat$/);
  await expect(panel(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__notificationLoading.writes)).toEqual([]);
});
