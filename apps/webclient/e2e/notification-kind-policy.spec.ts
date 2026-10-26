import { expect, test, type Page } from '@playwright/test';
import {
  NOTIFICATION_ANCHORED_KINDS,
  defaultNotificationKindPolicy,
  type NotificationAnchoredKind,
  type NotificationKindPolicy,
  type NotificationKindPolicySetRequest,
  type NotificationChannelName,
  type NotificationChannelModeRow,
} from '@recued/contracts';
import { installFullAppHooks } from './helpers/full-app.js';

type Outcome = 'success' | 'error' | 'disabled';
type Reply = { result?: unknown; error?: { code: string; message: string } };
interface PolicySaveFixture {
  calls: NotificationKindPolicySetRequest[];
  reads: number;
  failNextRead: boolean;
  failNextDescribe: boolean;
  setPolicies(next: NotificationKindPolicy[]): void;
  pending(): number;
  release(outcome: Outcome): boolean;
}
declare global { interface Window { __kindPolicySave: PolicySaveFixture } }

const panel = (page: Page) => page.locator('[data-recued-kind-policy-panel]');
const kindNames: Record<NotificationAnchoredKind, string> = {
  task: 'Task deadlines', commitment: 'Commitments', booking: 'Bookings', calendar: 'Calendar events',
};
const control = (page: Page, field: 'enabled' | 'offset', kind: NotificationAnchoredKind = 'task') => field === 'offset'
  ? panel(page).getByRole('combobox', { name: `${kindNames[kind]}: how far ahead`, exact: true })
  : panel(page).locator(`[data-recued-kind-policy-enabled="${kind}"]`);
const expectTimingNames = async (page: Page) => {
  await expect(panel(page).getByRole('combobox')).toHaveCount(4);
  for (const kind of NOTIFICATION_ANCHORED_KINDS) {
    await expect(control(page, 'offset', kind)).toHaveCount(1);
    await expect(control(page, 'offset', kind)).toHaveAccessibleName(`${kindNames[kind]}: how far ahead`);
    await expect(control(page, 'enabled', kind)).toHaveAccessibleName(kindNames[kind]);
  }
};
const status = (page: Page) => panel(page).locator('[data-recued-kind-policy-status]');
const outside = (page: Page) => page.getByRole('button', { name: 'Outside notification settings', exact: true });
const open = async (page: Page, width: number, initial: 'ready' | 'error' | 'held' = 'ready') => {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(({ seed, initial }) => {
    let policies = seed;
    const calls: NotificationKindPolicySetRequest[] = [];
    const waiting: Array<{ patch: NotificationKindPolicySetRequest; resolve: (reply: Reply) => void }> = [];
    const fixture: PolicySaveFixture = {
      calls,
      reads: 0, failNextRead: initial === 'error', failNextDescribe: false,
      setPolicies: next => { policies = structuredClone(next); },
      pending: () => waiting.length,
      release: outcome => {
        const next = waiting.shift();
        if (!next) return false;
        if (outcome === 'error') next.resolve({ error: { code: 'UNAVAILABLE', message: 'Timing setting unavailable.' } });
        else {
          policies = policies.map(policy => policy.kind === next.patch.kind
            ? { ...policy, ...next.patch, ...(outcome === 'disabled' ? { enabled: false } : {}), updated_at: Date.now() }
            : policy);
          next.resolve({ result: { policies: structuredClone(policies) } });
        }
        return true;
      },
    };
    // The existing full-app hook supplies only these fixture replies. The
    // production Settings route and policy panel own every interaction.
    Object.assign(window, {
      __kindPolicySave: fixture,
      __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
        if (method === 'notifications.describe' || method === 'notifications.describe_bridges') {
          if (method === 'notifications.describe' && fixture.failNextDescribe) {
            fixture.failNextDescribe = false; return { error: { code: 'UNAVAILABLE', message: 'Channel lookup unavailable.' } };
          }
          return { result: { rows: [] } };
        }
        if (method === 'notification.kind_policy.get') {
          fixture.reads++;
          if (fixture.failNextRead) { fixture.failNextRead = false;
            return { error: { code: 'UNAVAILABLE', message: 'Notification settings unavailable.' } }; }
          return { result: { policies: structuredClone(policies) } };
        }
        if (method === 'notification.kind_policy.set') {
          const patch = structuredClone(args as NotificationKindPolicySetRequest);
          calls.push(patch);
          return new Promise(resolve => { waiting.push({ patch, resolve }); });
        }
        return undefined;
      },
    });
    const button = document.createElement('button');
    button.textContent = 'Outside notification settings';
    document.body.appendChild(button);
    if (initial === 'held') window.__app.holdRpcResponses?.('notification.kind_policy.get');
    window.__app.setHash('#settings/notifications');
  }, { seed: NOTIFICATION_ANCHORED_KINDS.map(kind => defaultNotificationKindPolicy(kind)), initial });
  await expect(panel(page)).toHaveAttribute('data-recued-kind-policy-state', initial === 'held' ? 'loading' : initial);
  if (initial === 'error') await expect(panel(page).getByRole('alert')).toHaveText('Notification settings unavailable.');
};
const activate = async (page: Page, field: 'enabled' | 'offset') => {
  const target = control(page, field);
  await target.focus();
  if (field === 'enabled') await page.keyboard.press('Space');
  else await target.selectOption('3600000');
  await expect(status(page)).toHaveText('Saving notification settings…');
  await expect(status(page)).toHaveAttribute('role', 'status');
  await expect(status(page)).toBeFocused();
};
const release = (page: Page, outcome: Outcome) => page.evaluate(result => window.__kindPolicySave.release(result), outcome);
const patch = (field: 'enabled' | 'offset'): NotificationKindPolicySetRequest => field === 'enabled'
  ? { kind: 'task', enabled: false } : { kind: 'task', offset_ms: 3_600_000 };

installFullAppHooks();

type ChannelOutcome = 'success' | 'error' | 'not_ready';
type ChannelPatch = { channel: NotificationChannelName; patch: Partial<NotificationChannelModeRow> };
interface ReachabilityFixture {
  describes: number;
  policyReads: number;
  failNextPolicyRead: boolean;
  setChannels(next: Record<string, boolean>): void;
  channelCalls: ChannelPatch[];
  policyCalls: NotificationKindPolicySetRequest[];
  pendingChannels(): number;
  releaseChannel(outcome: ChannelOutcome, index?: number): boolean;
  releaseDescribe(outcome?: 'success' | 'error'): boolean;
}
declare global { interface Window { __reachabilitySync: ReachabilityFixture } }
const reachabilityHint = (page: Page) => panel(page).locator('[data-recued-kind-policy-unreachable]');
const channelToggle = (page: Page, channel = 'Telegram', axis = 'notifications') =>
  page.getByRole('switch', { name: `${channel} ${axis}`, exact: true });
const releaseChannel = (page: Page, outcome: ChannelOutcome = 'success', index = 0) =>
  page.evaluate(({ outcome, index }) => window.__reachabilitySync.releaseChannel(outcome, index), { outcome, index });
const reachabilityCounts = (page: Page) => page.evaluate(() => ({
  describes: window.__reachabilitySync.describes, policyReads: window.__reachabilitySync.policyReads,
  channelCalls: window.__reachabilitySync.channelCalls, policyCalls: window.__reachabilitySync.policyCalls,
}));
const openReachability = async (page: Page, width: number, options: {
  telegram?: boolean; slack?: boolean; policyDescribe?: 'ready' | 'error' | 'held'; failPolicyRead?: boolean; holdPolicyRead?: boolean;
} = {}) => {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(({ options, seed }) => {
    const channels: Record<string, boolean> = { telegram: options.telegram ?? false, slack: options.slack ?? false };
    const approvals: Record<string, boolean> = {};
    let policies = seed;
    const waiting: Array<{ args: ChannelPatch; resolve: (reply: Reply) => void }> = [];
    let describe: ((outcome: 'success' | 'error') => void) | null = null;
    const mode = (channel: string) => ({ notification: channels[channel] ?? false, approval: approvals[channel] ?? false, messenger: false });
    const fixture: ReachabilityFixture = {
      describes: 0, policyReads: 0, failNextPolicyRead: options.failPolicyRead ?? false,
      setChannels: next => { Object.assign(channels, next); }, channelCalls: [], policyCalls: [],
      pendingChannels: () => waiting.length,
      releaseDescribe: (outcome = 'success') => { if (!describe) return false; const done = describe; describe = null; done(outcome); return true; },
      releaseChannel: (outcome, index = 0) => {
        const [next] = waiting.splice(index, 1); if (!next) return false;
        if (outcome === 'error') next.resolve({ error: { code: 'UNAVAILABLE', message: 'Channel setting unavailable.' } });
        else if (outcome === 'not_ready') next.resolve({ result: { ok: false, reason: 'not_ready', channel: next.args.channel } });
        else {
          if (typeof next.args.patch.notification === 'boolean') channels[next.args.channel] = next.args.patch.notification;
          if (typeof next.args.patch.approval === 'boolean') approvals[next.args.channel] = next.args.patch.approval;
          next.resolve({ result: { ok: true, settings: { ui: true, bridge: false,
            telegram: mode('telegram'), slack: mode('slack'), email: mode('email'), teams: mode('teams'),
            whatsapp: mode('whatsapp'), discord: mode('discord'), bridges: {},
          } } });
        }
        return true;
      },
    };
    Object.assign(window, {
      __reachabilitySync: fixture,
      __connectionsFixture: async (method: string, args: unknown): Promise<Reply | undefined> => {
        if (method === 'notifications.describe') {
          fixture.describes++;
          const reply = { result: { rows: [
            { channel: 'ui', capability: 'inline', notification: true, approval: true, notification_togglable: false, approval_togglable: false, ready: true },
            ...['telegram', 'slack'].map(channel => ({ channel, capability: 'inline', notification: channels[channel],
              approval: approvals[channel] ?? false, notification_togglable: true, approval_togglable: true, ready: true })),
          ] } };
          if (fixture.describes === 2 && options.policyDescribe === 'error') return { error: { code: 'UNAVAILABLE', message: 'Channel lookup unavailable.' } };
          if (fixture.describes === 2 && options.policyDescribe === 'held') return new Promise(resolve => { describe = outcome => resolve(outcome === 'success'
            ? reply : { error: { code: 'UNAVAILABLE', message: 'Channel lookup unavailable.' } }); });
          return reply;
        }
        if (method === 'notifications.describe_bridges') return { result: { rows: [] } };
        if (method === 'notifications.set_channel') {
          const patch = structuredClone(args as ChannelPatch); fixture.channelCalls.push(patch);
          return new Promise(resolve => waiting.push({ args: patch, resolve }));
        }
        if (method === 'notification.kind_policy.get') {
          fixture.policyReads++;
          if (fixture.failNextPolicyRead) { fixture.failNextPolicyRead = false;
            return { error: { code: 'UNAVAILABLE', message: 'Notification settings unavailable.' } }; }
          return { result: { policies: structuredClone(policies) } };
        }
        if (method === 'notification.kind_policy.set') {
          const patch = structuredClone(args as NotificationKindPolicySetRequest); fixture.policyCalls.push(patch);
          policies = policies.map(policy => policy.kind === patch.kind ? { ...policy, ...patch } : policy);
          return { result: { policies: structuredClone(policies) } };
        }
        return undefined;
      },
    });
    if (options.holdPolicyRead) window.__app.holdRpcResponses?.('notification.kind_policy.get');
    window.__app.setHash('#settings/notifications');
  }, { options, seed: NOTIFICATION_ANCHORED_KINDS.map(kind => ({ ...defaultNotificationKindPolicy(kind),
    ...(kind === 'booking' ? { offset_ms: 45 * 60_000 } : {}),
  })) });
  await expect(channelToggle(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute('data-recued-kind-policy-state', options.holdPolicyRead ? 'loading' : options.failPolicyRead ? 'error' : 'ready');
};

for (const width of [390]) {
  for (const outcome of ['success', 'error'] as const) {
    test(`independent timing load waits for policy after channel lookup ${outcome} at ${width}px`, async ({ page }) => {
      await openReachability(page, width, { policyDescribe: 'held', holdPolicyRead: true });
      await expect(readStatus(page)).toHaveText('Loading notification settings…'); const loading = await readStatus(page).elementHandle();
      await channelToggle(page).focus();
      expect(await page.evaluate(outcome => window.__reachabilitySync.releaseDescribe(outcome), outcome)).toBe(true);
      await expect(panel(page)).toHaveAttribute('data-recued-kind-policy-state', 'loading');
      await expect(readStatus(page)).toHaveText('Loading notification settings…'); await expect(panel(page).getByRole('alert')).toHaveCount(0);
      await expect(control(page, 'enabled')).toHaveCount(0); await expect(retryRead(page)).toHaveCount(0);
      await expect(channelToggle(page)).toBeFocused(); expect(await loading!.evaluate(node => node.isConnected)).toBe(true);
      expect(await unloadBlocked(page)).toBe(false); expect(await releaseRead(page)).toBe(1);
      await expectTimingNames(page); await expect(channelToggle(page)).toBeFocused();
      await expect(reachabilityHint(page)).toHaveCount(outcome === 'success' ? 1 : 0);
      expect(await reachabilityCounts(page)).toEqual({ describes: 2, policyReads: 1, policyCalls: [], channelCalls: [] });
    });

    test(`independent timing load exposes controls before a channel lookup ${outcome} at ${width}px`, async ({ page }) => {
      await openReachability(page, width, { policyDescribe: 'held' }); await expectTimingNames(page);
      await expect(reachabilityHint(page)).toHaveCount(0); await control(page, 'offset', 'booking').focus();
      const timing = await control(page, 'offset', 'booking').elementHandle(); const before = await reachabilityCounts(page);
      expect(before).toEqual({ describes: 2, policyReads: 1, policyCalls: [], channelCalls: [] });
      expect(await page.evaluate(outcome => window.__reachabilitySync.releaseDescribe(outcome), outcome)).toBe(true);
      await expect(reachabilityHint(page)).toHaveCount(outcome === 'success' ? 1 : 0);
      await expect(control(page, 'offset', 'booking')).toBeFocused(); await expect(control(page, 'offset', 'booking')).toHaveValue('2700000');
      expect(await timing!.evaluate(node => node.isConnected)).toBe(true); expect(await reachabilityCounts(page)).toEqual(before);
      expect(await unloadBlocked(page)).toBe(false);
    });

    test(`independent timing load keeps a pending save and its focus through channel lookup ${outcome} at ${width}px`, async ({ page }) => {
      await openReachability(page, width, { policyDescribe: 'held' });
      await page.evaluate(() => window.__app.holdRpcResponses?.('notification.kind_policy.set'));
      await activate(page, 'offset'); const saving = await status(page).elementHandle(); const before = await reachabilityCounts(page);
      expect(await page.evaluate(outcome => window.__reachabilitySync.releaseDescribe(outcome), outcome)).toBe(true);
      await expect(reachabilityHint(page)).toHaveCount(outcome === 'success' ? 1 : 0);
      await expect(status(page)).toHaveText('Saving notification settings…'); await expect(status(page)).toBeFocused();
      expect(await saving!.evaluate(node => node.isConnected)).toBe(true); expect(await reachabilityCounts(page)).toEqual(before);
      expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('notification.kind_policy.set'))).toBe(1);
      await expect(status(page)).toHaveText('Notification settings saved.'); await expect(control(page, 'offset')).toBeFocused();
      await expect(control(page, 'offset')).toHaveValue('3600000'); expect((await reachabilityCounts(page)).policyReads).toBe(1);
    });
  }

  test(`independent timing load retries failed policy reads while sharing a pending channel lookup at ${width}px`, async ({ page }) => {
    await openReachability(page, width, { policyDescribe: 'held', failPolicyRead: true });
    await expect(panel(page).getByRole('alert')).toHaveText('Notification settings unavailable.');
    await holdRead(page); await page.evaluate(() => { window.__reachabilitySync.failNextPolicyRead = true; });
    await retryRead(page).focus(); await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__reachabilitySync.policyReads)).toBe(2);
    await expect(retryRead(page)).toHaveAttribute('aria-disabled', 'true'); await page.keyboard.press('Space');
    await page.keyboard.press('Enter'); expect((await reachabilityCounts(page)).policyReads).toBe(2);
    expect((await reachabilityCounts(page)).describes).toBe(2); expect(await releaseRead(page)).toBe(1);
    await expect(panel(page).getByRole('alert')).toHaveText('Notification settings unavailable.'); await expect(retryRead(page)).toBeFocused();
    await page.keyboard.press('Space'); await expect.poll(() => page.evaluate(() => window.__reachabilitySync.policyReads)).toBe(3);
    expect(await releaseRead(page)).toBe(1); await expectTimingNames(page); await expect(control(page, 'enabled')).toBeFocused();
    const setting = await control(page, 'enabled').elementHandle(); expect((await reachabilityCounts(page)).describes).toBe(2);
    expect(await page.evaluate(() => window.__reachabilitySync.releaseDescribe())).toBe(true); await expect(reachabilityHint(page)).toBeVisible();
    await expect(control(page, 'enabled')).toBeFocused(); expect(await setting!.evaluate(node => node.isConnected)).toBe(true);
    expect(await reachabilityCounts(page)).toEqual({ describes: 2, policyReads: 3, policyCalls: [], channelCalls: [] });
    expect(await unloadBlocked(page)).toBe(false);
  });

  test(`independent timing load preserves a policy error when the channel lookup finishes at ${width}px`, async ({ page }) => {
    await openReachability(page, width, { policyDescribe: 'held', failPolicyRead: true });
    await retryRead(page).focus(); const retry = await retryRead(page).elementHandle();
    expect(await page.evaluate(() => window.__reachabilitySync.releaseDescribe())).toBe(true);
    await expect(panel(page).getByRole('alert')).toHaveText('Notification settings unavailable.'); await expect(retryRead(page)).toBeFocused();
    expect(await retry!.evaluate(node => node.isConnected)).toBe(true); await expect(control(page, 'enabled')).toHaveCount(0);
    await retryRead(page).press('Enter'); await expectTimingNames(page); await expect(control(page, 'enabled')).toBeFocused();
    expect((await reachabilityCounts(page)).policyCalls).toEqual([]);
  });

  test(`independent timing load leaves another Settings section focused when channel data arrives at ${width}px`, async ({ page }) => {
    await openReachability(page, width, { policyDescribe: 'held' }); const before = await reachabilityCounts(page);
    const server = page.locator('[data-recued-settings-nav-item="server"]'); await server.press('Enter');
    await expect(server).toBeFocused();
    await expect(page).toHaveURL(/#settings\/server$/u); expect(await page.evaluate(() => window.__reachabilitySync.releaseDescribe())).toBe(true);
    await expect(reachabilityHint(page)).toHaveCount(1); await expect(panel(page)).not.toBeVisible(); await expect(server).toBeFocused();
    await page.locator('[data-recued-settings-nav-item="notifications"]').click(); await expect(reachabilityHint(page)).toBeVisible();
    await expectTimingNames(page); expect(await reachabilityCounts(page)).toEqual(before); expect(await unloadBlocked(page)).toBe(false);
  });

  test(`independent timing load ignores channel data from a disposed Settings route at ${width}px`, async ({ page }) => {
    await openReachability(page, width, { policyDescribe: 'held' });
    await page.evaluate(() => window.__reachabilitySync.setChannels({ telegram: true }));
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.evaluate(() => window.__app.setHash('#today')); await expect(panel(page)).toHaveCount(0); expect(dialogs).toEqual([]);
    await page.evaluate(() => window.__app.setHash('#settings/notifications')); await expectTimingNames(page);
    await expect(channelToggle(page)).toHaveAttribute('aria-checked', 'true'); await expect(reachabilityHint(page)).toHaveCount(0);
    await control(page, 'offset', 'booking').focus(); const timing = await control(page, 'offset', 'booking').elementHandle();
    expect(await page.evaluate(() => window.__reachabilitySync.releaseDescribe())).toBe(true); await expect(reachabilityHint(page)).toHaveCount(0);
    await expect(control(page, 'offset', 'booking')).toBeFocused(); expect(await timing!.evaluate(node => node.isConnected)).toBe(true);
    expect((await reachabilityCounts(page)).policyCalls).toEqual([]); expect((await reachabilityCounts(page)).policyReads).toBe(2);
  });
}

for (const width of [390]) {
  test(`reachability hint follows confirmed channel changes without reloading timing controls at ${width}px`, async ({ page }) => {
    await openReachability(page, width); await expect(reachabilityHint(page)).toBeVisible();
    const timing = await control(page, 'offset', 'booking').elementHandle(); const before = await reachabilityCounts(page);
    await channelToggle(page).focus(); await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__reachabilitySync.pendingChannels())).toBe(1);
    await expect(reachabilityHint(page)).toBeVisible(); expect(await releaseChannel(page)).toBe(true);
    await expect(channelToggle(page)).toHaveAttribute('aria-checked', 'true'); await expect(channelToggle(page)).toBeFocused();
    await expect(reachabilityHint(page)).toHaveCount(0);
    expect(await timing!.evaluate(node => node.isConnected)).toBe(true); await expect(control(page, 'offset', 'booking')).toHaveValue('2700000');
    await page.keyboard.press('Enter'); await expect.poll(() => page.evaluate(() => window.__reachabilitySync.pendingChannels())).toBe(1);
    await expect(reachabilityHint(page)).toHaveCount(0); expect(await releaseChannel(page)).toBe(true);
    await expect(reachabilityHint(page)).toBeVisible(); await expect(channelToggle(page)).toBeFocused();
    const after = await reachabilityCounts(page);
    expect(after).toEqual({ ...before, channelCalls: [
      { channel: 'telegram', patch: { notification: true } }, { channel: 'telegram', patch: { notification: false } },
    ] });
    expect(await timing!.evaluate(node => node.isConnected)).toBe(true);
  });

  test(`reachability hint counts every external notification channel and ignores approval changes at ${width}px`, async ({ page }) => {
    await openReachability(page, width, { telegram: true, slack: true }); await expect(reachabilityHint(page)).toHaveCount(0);
    await channelToggle(page).click(); expect(await releaseChannel(page)).toBe(true); await expect(channelToggle(page)).toHaveAttribute('aria-checked', 'false');
    await expect(reachabilityHint(page)).toHaveCount(0);
    await channelToggle(page, 'Slack').click(); expect(await releaseChannel(page)).toBe(true); await expect(reachabilityHint(page)).toBeVisible();
    await channelToggle(page, 'Telegram', 'approvals').click(); expect(await releaseChannel(page)).toBe(true);
    await expect(channelToggle(page, 'Telegram', 'approvals')).toHaveAttribute('aria-checked', 'true'); await expect(reachabilityHint(page)).toBeVisible();
    expect((await reachabilityCounts(page)).policyCalls).toEqual([]);
  });

  for (const enabled of [false, true]) {
    for (const outcome of ['error', 'not_ready'] as const) {
      test(`reachability hint preserves ${enabled ? 'external' : 'in-app-only'} guidance after a ${outcome} channel save at ${width}px`, async ({ page }) => {
        await openReachability(page, width, { telegram: enabled });
        await expect(reachabilityHint(page)).toHaveCount(enabled ? 0 : 1); const before = await reachabilityCounts(page);
        await channelToggle(page).click(); await control(page, 'offset', 'booking').focus();
        const timing = await control(page, 'offset', 'booking').elementHandle(); expect(await releaseChannel(page, outcome)).toBe(true);
        await expect(channelToggle(page)).toHaveAttribute('aria-checked', String(enabled)); await expect(channelToggle(page)).toBeEnabled();
        await expect(reachabilityHint(page)).toHaveCount(enabled ? 0 : 1); await expect(control(page, 'offset', 'booking')).toBeFocused();
        expect(await timing!.evaluate(node => node.isConnected)).toBe(true);
        expect(await reachabilityCounts(page)).toEqual({ ...before, channelCalls: [{ channel: 'telegram', patch: { notification: !enabled } }] });
      });
    }

    test(`reachability hint merges reversed concurrent channel ${enabled ? 'disables' : 'enables'} at ${width}px`, async ({ page }) => {
      await openReachability(page, width, { telegram: enabled, slack: enabled });
      const before = await reachabilityCounts(page); const timing = await control(page, 'offset', 'booking').elementHandle();
      await channelToggle(page).click(); await channelToggle(page, 'Slack').click();
      await expect.poll(() => page.evaluate(() => window.__reachabilitySync.pendingChannels())).toBe(2);
      await expect(reachabilityHint(page)).toHaveCount(enabled ? 0 : 1); await control(page, 'offset', 'booking').focus();
      expect(await releaseChannel(page, 'success', 1)).toBe(true);
      await expect(channelToggle(page, 'Slack')).toHaveAttribute('aria-checked', String(!enabled));
      await expect(reachabilityHint(page)).toHaveCount(0); await expect(control(page, 'offset', 'booking')).toBeFocused();
      expect(await releaseChannel(page)).toBe(true); await expect(channelToggle(page)).toHaveAttribute('aria-checked', String(!enabled));
      await expect(reachabilityHint(page)).toHaveCount(enabled ? 1 : 0); await expect(control(page, 'offset', 'booking')).toBeFocused();
      expect(await timing!.evaluate(node => node.isConnected)).toBe(true);
      expect(await reachabilityCounts(page)).toEqual({ ...before, channelCalls: [
        { channel: 'telegram', patch: { notification: !enabled } }, { channel: 'slack', patch: { notification: !enabled } },
      ] });
    });
  }

  test(`reachability hint changes preserve a pending timing save and its focus at ${width}px`, async ({ page }) => {
    await openReachability(page, width); await channelToggle(page).click();
    await page.evaluate(() => window.__app.holdRpcResponses?.('notification.kind_policy.set'));
    await activate(page, 'offset'); const saving = await status(page).elementHandle(); const before = await reachabilityCounts(page);
    expect(await releaseChannel(page)).toBe(true); await expect(reachabilityHint(page)).toHaveCount(0);
    await expect(status(page)).toHaveText('Saving notification settings…'); await expect(status(page)).toBeFocused();
    expect(await saving!.evaluate(node => node.isConnected)).toBe(true); expect(await reachabilityCounts(page)).toEqual(before);
    expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('notification.kind_policy.set'))).toBe(1);
    await expect(status(page)).toHaveText('Notification settings saved.'); await expect(control(page, 'offset')).toBeFocused();
    await expect(reachabilityHint(page)).toHaveCount(0); await expect(control(page, 'offset')).toHaveValue('3600000');
  });

  test(`reachability hint keeps an unread channel roster unknown after confirmed toggles at ${width}px`, async ({ page }) => {
    await openReachability(page, width, { telegram: true, policyDescribe: 'error' }); await expect(reachabilityHint(page)).toHaveCount(0);
    for (const checked of [false, true, false]) {
      await channelToggle(page).click(); expect(await releaseChannel(page)).toBe(true);
      await expect(channelToggle(page)).toHaveAttribute('aria-checked', String(checked)); await expect(reachabilityHint(page)).toHaveCount(0);
    }
    expect((await reachabilityCounts(page)).policyReads).toBe(1); expect((await reachabilityCounts(page)).policyCalls).toEqual([]);
  });

  test(`reachability hint ignores an older initial roster after a confirmed channel change at ${width}px`, async ({ page }) => {
    await openReachability(page, width, { policyDescribe: 'held' }); await channelToggle(page).press('Space');
    await expect(channelToggle(page)).toBeFocused();
    expect(await releaseChannel(page)).toBe(true); await expect(channelToggle(page)).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => window.__reachabilitySync.releaseDescribe())).toBe(true); await expectTimingNames(page);
    await expect(reachabilityHint(page)).toHaveCount(0); await expect(channelToggle(page)).toBeFocused();
    expect((await reachabilityCounts(page)).policyCalls).toEqual([]);
  });

  test(`reachability hint drops a late channel save after leaving Settings at ${width}px`, async ({ page }) => {
    await openReachability(page, width); await channelToggle(page).click();
    const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
    await page.evaluate(() => window.__app.setHash('#today')); await expect(panel(page)).toHaveCount(0); expect(dialogs).toHaveLength(1);
    await page.evaluate(() => window.__app.setHash('#settings/notifications')); await expectTimingNames(page); await expect(reachabilityHint(page)).toBeVisible();
    await control(page, 'offset', 'booking').focus(); const timing = await control(page, 'offset', 'booking').elementHandle();
    expect(await releaseChannel(page)).toBe(true); await expect(reachabilityHint(page)).toBeVisible(); await expect(control(page, 'offset', 'booking')).toBeFocused();
    expect(await timing!.evaluate(node => node.isConnected)).toBe(true);
    expect((await reachabilityCounts(page)).policyCalls).toEqual([]);
  });
}

const retryRead = (page: Page) => panel(page).getByRole('button', { name: 'Retry loading notification settings', exact: true });
const readStatus = (page: Page) => panel(page).getByRole('status');
const reads = (page: Page) => page.evaluate(() => window.__kindPolicySave.reads);
const holdRead = (page: Page) => page.evaluate(() => window.__app.holdRpcResponses?.('notification.kind_policy.get'));
const releaseRead = (page: Page, index?: number) => page.evaluate(index => window.__app.releaseRpcResponses?.('notification.kind_policy.get', index), index);
const unloadBlocked = (page: Page) => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
});

for (const width of [390]) {
  test(`initial policy read retry keeps keyboard focus through failures and sends one attempt at ${width}px`, async ({ page }) => {
    await open(page, width, 'error'); await expect(retryRead(page)).toBeVisible();
    if (width === 390) expect((await retryRead(page).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const original = await retryRead(page).elementHandle();
    await holdRead(page); await page.evaluate(() => { window.__kindPolicySave.failNextRead = true; });
    await retryRead(page).focus(); await page.keyboard.press('Enter');
    await expect(readStatus(page)).toHaveText('Retrying notification settings…');
    await expect(retryRead(page)).toBeFocused(); await expect(retryRead(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(retryRead(page)).toHaveAttribute('aria-busy', 'true'); await expect(panel(page).getByRole('alert')).toHaveCount(0);
    await expect.poll(() => reads(page)).toBe(2);
    await page.keyboard.press('Space'); await page.keyboard.press('Enter');
    await retryRead(page).evaluate(button => (button as HTMLButtonElement).click());
    expect(await reads(page)).toBe(2); expect(await unloadBlocked(page)).toBe(false);
    expect(await releaseRead(page)).toBe(1); await expect(panel(page).getByRole('alert')).toHaveText('Notification settings unavailable.');
    await expect(retryRead(page)).toBeFocused(); await expect(retryRead(page)).toHaveAttribute('aria-disabled', 'false');
    expect(await original!.evaluate(button => button.isConnected && button === document.activeElement)).toBe(true);
    await page.keyboard.press('Space'); await expect.poll(() => reads(page)).toBe(3); expect(await releaseRead(page)).toBe(1);
    await expectTimingNames(page); await expect(control(page, 'enabled')).toBeFocused(); await expect(retryRead(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`initial policy read retry uses current per-kind settings and preserves save recovery at ${width}px`, async ({ page }) => {
    await open(page, width, 'error');
    await page.evaluate(seed => window.__kindPolicySave.setPolicies(seed), NOTIFICATION_ANCHORED_KINDS.map(kind => ({
      ...defaultNotificationKindPolicy(kind), ...(kind === 'booking' ? { offset_ms: 45 * 60_000 } : {}),
      ...(kind === 'commitment' ? { enabled: false } : {}),
    })));
    await retryRead(page).press('Enter'); await expectTimingNames(page);
    await expect(control(page, 'offset', 'booking')).toHaveValue('2700000');
    await expect(control(page, 'offset', 'commitment')).toBeDisabled();
    await expect(control(page, 'enabled', 'commitment')).not.toBeChecked();
    expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([]);
    await activate(page, 'offset'); await release(page, 'error');
    await expect(control(page, 'offset')).toBeFocused(); await expect(panel(page).getByRole('alert')).toHaveText('Timing setting unavailable.');
    await activate(page, 'offset'); await release(page, 'success'); await expect(status(page)).toHaveText('Notification settings saved.');
    await expect(control(page, 'offset')).toBeFocused(); await expect(control(page, 'offset', 'booking')).toHaveValue('2700000');
    expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([patch('offset'), patch('offset')]);
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`initial policy read retry respects outside focus after ${outcome} at ${width}px`, async ({ page }) => {
      await open(page, width, 'error'); await holdRead(page);
      await page.evaluate(outcome => { window.__kindPolicySave.failNextRead = outcome === 'error'; }, outcome);
      await retryRead(page).press('Enter'); await expect.poll(() => reads(page)).toBe(2); await outside(page).focus();
      expect(await releaseRead(page)).toBe(1);
      await expect(panel(page)).toHaveAttribute('data-recued-kind-policy-state', outcome === 'success' ? 'ready' : 'error');
      await expect(outside(page)).toBeFocused(); expect(await unloadBlocked(page)).toBe(false);
      expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([]);
    });

    test(`initial policy read retry leaves another Settings section focused after ${outcome} at ${width}px`, async ({ page }) => {
      await open(page, width, 'error'); await holdRead(page);
      await page.evaluate(outcome => { window.__kindPolicySave.failNextRead = outcome === 'error'; }, outcome);
      await retryRead(page).press('Enter'); await expect.poll(() => reads(page)).toBe(2);
      const serverNav = page.locator('[data-recued-settings-nav-item="server"]');
      await serverNav.press('Enter'); await expect(page).toHaveURL(/#settings\/server$/u);
      await expect(serverNav).toBeFocused();
      expect(await releaseRead(page)).toBe(1);
      await expect(panel(page)).toHaveAttribute('data-recued-kind-policy-state', outcome === 'success' ? 'ready' : 'error');
      await expect(serverNav).toBeFocused(); await expect(panel(page)).not.toBeVisible();
      await page.locator('[data-recued-settings-nav-item="notifications"]').click();
      if (outcome === 'success') await expectTimingNames(page);
      else await expect(retryRead(page)).toBeEnabled();
      expect(await unloadBlocked(page)).toBe(false); expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([]);
    });

    test(`initial policy read retry ignores a disposed ${outcome} without guarding departure at ${width}px`, async ({ page }) => {
      await open(page, width, 'error'); await holdRead(page);
      await page.evaluate(outcome => { window.__kindPolicySave.failNextRead = outcome === 'error'; }, outcome);
      await retryRead(page).press('Enter'); await expect.poll(() => reads(page)).toBe(2); expect(await unloadBlocked(page)).toBe(false);
      const dialogs: string[] = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
      await page.evaluate(() => window.__app.setHash('#today')); await expect(panel(page)).toHaveCount(0); expect(dialogs).toEqual([]);
      await page.evaluate(() => window.__app.setHash('#settings/notifications')); await expect.poll(() => reads(page)).toBe(3);
      expect(await releaseRead(page, 1)).toBe(1); await expectTimingNames(page);
      await control(page, 'offset', 'booking').focus(); const fresh = await control(page, 'offset', 'booking').elementHandle();
      expect(await releaseRead(page, 0)).toBe(1);
      await expect(control(page, 'offset', 'booking')).toBeFocused(); await expectTimingNames(page);
      expect(await fresh!.evaluate(node => node.isConnected && node === document.activeElement)).toBe(true);
      await expect(panel(page).getByRole('alert')).toHaveCount(0); await expect(retryRead(page)).toHaveCount(0);
      expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([]);
    });
  }

  test(`a successful first policy read keeps outside focus and exposes no Retry at ${width}px`, async ({ page }) => {
    await open(page, width, 'held'); await expect.poll(() => reads(page)).toBe(1); await outside(page).focus();
    await expect(readStatus(page)).toHaveText('Loading notification settings…'); await expect(retryRead(page)).toHaveCount(0);
    expect(await unloadBlocked(page)).toBe(false); expect(await releaseRead(page)).toBe(1);
    await expectTimingNames(page); await expect(outside(page)).toBeFocused(); expect(await reads(page)).toBe(1);
    expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([]);
  });

  test(`initial policy read retry recovers an empty snapshot without changing settings at ${width}px`, async ({ page }) => {
    await open(page, width, 'error');
    await page.evaluate(() => window.__kindPolicySave.setPolicies([]));
    await retryRead(page).press('Enter');
    await expect(panel(page).getByRole('alert')).toHaveText('Could not read your notification settings.');
    await expect(retryRead(page)).toBeFocused(); await expect(retryRead(page)).toHaveAttribute('aria-disabled', 'false');
    await expect(panel(page).locator('input, select')).toHaveCount(0); expect(await reads(page)).toBe(2);
    await page.evaluate(seed => window.__kindPolicySave.setPolicies(seed), NOTIFICATION_ANCHORED_KINDS.map(kind => defaultNotificationKindPolicy(kind)));
    await retryRead(page).press('Space'); await expectTimingNames(page); await expect(control(page, 'enabled')).toBeFocused();
    await expect(panel(page).getByRole('alert')).toHaveCount(0); expect(await reads(page)).toBe(3);
    expect(await unloadBlocked(page)).toBe(false); expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([]);
  });

  test(`initial policy read retry tolerates a failed channel lookup without a false warning at ${width}px`, async ({ page }) => {
    await open(page, width, 'error'); await page.evaluate(() => { window.__kindPolicySave.failNextDescribe = true; });
    await retryRead(page).press('Enter'); await expectTimingNames(page);
    await expect(panel(page).locator('[data-recued-kind-policy-unreachable]')).toHaveCount(0);
    await expect(control(page, 'enabled')).toBeFocused(); expect(await reads(page)).toBe(2);
    expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([]);
  });
}

for (const width of [390]) {
  test(`each timing dropdown has a distinct accessible name at ${width}px`, async ({ page }) => {
    await open(page, width);
    await expectTimingNames(page);
    expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([]);
  });

  for (const kind of NOTIFICATION_ANCHORED_KINDS) {
    test(`${kind} timing keeps its accessible name through refusal, retry and disabling at ${width}px`, async ({ page }) => {
      await open(page, width);
      const timing = control(page, 'offset', kind);
      const checkbox = panel(page).getByRole('checkbox', { name: kindNames[kind], exact: true });
      const previous = await timing.inputValue();
      await timing.focus();
      await timing.selectOption('3600000');
      await expect(status(page)).toHaveText('Saving notification settings…');
      await expect(status(page)).toBeFocused();
      await expect(timing).toBeDisabled();
      await expectTimingNames(page);
      await release(page, 'error');
      await expect(panel(page).getByRole('alert')).toContainText('Timing setting unavailable.');
      await expect(timing).toHaveValue(previous);
      await expect(timing).toBeFocused();
      await expectTimingNames(page);
      await timing.selectOption('3600000');
      await expect(status(page)).toHaveText('Saving notification settings…');
      await expectTimingNames(page);
      await release(page, 'success');
      await expect(status(page)).toHaveText('Notification settings saved.');
      await expect(timing).toHaveValue('3600000');
      await expect(timing).toBeFocused();
      await expectTimingNames(page);
      await checkbox.focus();
      await page.keyboard.press('Space');
      await expect(status(page)).toHaveText('Saving notification settings…');
      await release(page, 'success');
      await expect(status(page)).toHaveText('Notification settings saved.');
      await expect(checkbox).not.toBeChecked();
      await expect(timing).toBeDisabled();
      await expectTimingNames(page);
      expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([
        { kind, offset_ms: 3_600_000 }, { kind, offset_ms: 3_600_000 }, { kind, enabled: false },
      ]);
    });
  }

  for (const field of ['enabled', 'offset'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      for (const owner of ['status', 'outside', 'link'] as const) {
        test(`${field} ${outcome} retains ${owner} focus through a save at ${width}px`, async ({ page }) => {
          await open(page, width);
          const target = control(page, field);
          const previous = field === 'enabled' ? await target.isChecked() : await target.inputValue();
          const old = await target.elementHandle();
          await activate(page, field);
          await expect(status(page)).toBeInViewport();
          expect(await panel(page).locator('input,select').evaluateAll(nodes => nodes.every(node =>
            (node as HTMLInputElement | HTMLSelectElement).disabled))).toBe(true);
          // Disabled and detached controls are still guarded if an old event arrives.
          await old!.evaluate(node => { node.dispatchEvent(new Event('change')); node.dispatchEvent(new Event('change')); });
          expect(await page.evaluate(() => window.__kindPolicySave.pending())).toBe(1);
          const link = panel(page).getByRole('link', { name: 'Open Yours', exact: true });
          if (owner === 'outside') await outside(page).focus();
          else if (owner === 'link') await link.focus();
          expect(await release(page, outcome)).toBe(true);
          await expect(target).toBeEnabled();
          if (outcome === 'error') {
            await expect(panel(page).getByRole('alert')).toContainText('Timing setting unavailable.');
            await expect(status(page)).toHaveCount(0);
          } else {
            await expect(status(page)).toHaveText('Notification settings saved.');
            await expect(panel(page).getByRole('alert')).toHaveCount(0);
          }
          if (field === 'enabled') await expect(target).toBeChecked({ checked: outcome === 'success' ? false : previous as boolean });
          else await expect(target).toHaveValue(outcome === 'success' ? '3600000' : previous as string);
          if (owner === 'outside') await expect(outside(page)).toBeFocused();
          else if (owner === 'link') await expect(link).toBeFocused();
          else {
            await expect(target).toBeFocused();
            await expect(target).toBeInViewport();
            await page.keyboard.press('Tab');
            await expect(target).not.toBeFocused();
            const nextKind = field === 'enabled' && outcome === 'error' ? 'task' : 'commitment';
            // Native Tab can skip checkboxes. It must still continue in the
            // correct row rather than returning to the start of the panel.
            await expect.poll(() => panel(page).evaluate(root => {
              const active = root.ownerDocument.activeElement;
              return active !== null && root.contains(active)
                ? active.getAttribute('data-recued-kind-policy-enabled') ?? active.getAttribute('data-recued-kind-policy-offset')
                : null;
            })).toBe(nextKind);
          }
          expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([patch(field)]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        });
      }
    }

    test(`${field} can retry a refused save at ${width}px`, async ({ page }) => {
      await open(page, width);
      await activate(page, field);
      await release(page, 'error');
      await expect(panel(page).getByRole('alert')).toBeVisible();
      await expect(control(page, field)).toBeFocused();
      await activate(page, field);
      await release(page, 'success');
      await expect(status(page)).toHaveText('Notification settings saved.');
      await expect(control(page, field)).toBeFocused();
      expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([patch(field), patch(field)]);
    });
  }

  test(`an offset reply that disables its kind returns focus to that kind's checkbox at ${width}px`, async ({ page }) => {
    await open(page, width);
    await activate(page, 'offset');
    await release(page, 'disabled');
    await expect(status(page)).toHaveText('Notification settings saved.');
    await expect(control(page, 'offset')).toBeDisabled();
    await expect(control(page, 'enabled')).not.toBeChecked();
    await expect(control(page, 'enabled')).toBeFocused();
    expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([patch('offset')]);
  });

  test(`a change without field focus leaves the current owner alone at ${width}px`, async ({ page }) => {
    await open(page, width);
    await outside(page).focus();
    await control(page, 'offset').selectOption('3600000');
    await expect(status(page)).toHaveText('Saving notification settings…');
    await expect(outside(page)).toBeFocused();
    await release(page, 'success');
    await expect(status(page)).toHaveText('Notification settings saved.');
    await expect(outside(page)).toBeFocused();
    expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([patch('offset')]);
  });

  for (const outcome of ['success', 'error'] as const) {
    test(`leaving Settings retires a pending ${outcome} save's focus at ${width}px`, async ({ page }) => {
      await open(page, width);
      await activate(page, 'enabled');
      await outside(page).focus();
      await page.evaluate(() => window.__app.setHash('#today'));
      await expect(panel(page)).toHaveCount(0);
      await release(page, outcome);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(outside(page)).toBeFocused();
      await expect(panel(page)).toHaveCount(0);
      expect(await page.evaluate(() => window.__kindPolicySave.calls)).toEqual([patch('enabled')]);
    });
  }
}
