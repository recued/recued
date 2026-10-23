import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  CHAT_SETUP, FIXED_NOW, HARNESS_URL, SETTINGS_NAV_ITEM, installFullAppHooks,
} from './helpers/full-app.js';

/**
 * AI Models browser journeys against the deterministic full-app harness.
 * Shares the app boot and uncaught-page-error gates with full-app.spec.ts.
 * Included in e2e:webclient:full and the standard webclient Playwright config.
 */
const AI_MODELS_TAB = 'data-recued-ai-models-tab';
const AI_MODELS_PROMPT_TEXT = 'data-recued-ai-models-prompt-text';
const AI_MODELS_PROMPT_SAVE = 'data-recued-ai-models-prompt-save';
const AI_MODELS_PROMPT_LOAD_DEFAULT =
  'data-recued-ai-models-prompt-load-default';
const AI_MODELS_PROMPT_STATUS = 'data-recued-ai-models-prompt-status';
const AI_MODELS_PROMPT_SECTION = 'data-recued-ai-models-prompt';
const AI_MODELS_PROMPT_BADGE = 'data-recued-ai-models-prompt-badge';
const AI_MODELS_SLOT_CLEAR_DIALOG = 'data-recued-ai-models-slot-clear-dialog';
const AI_MODELS_SLOT_CLEAR_CANCEL = 'data-recued-ai-models-slot-clear-cancel';
const AI_MODELS_SLOT_CLEAR_CONFIRM = 'data-recued-ai-models-slot-clear-confirm';

installFullAppHooks();

for (const method of ['chat.rolling_brief.get', 'chat.install_offers.get']) {
  test(`Settings AI Models waits for ${method} before completing initialization`, async ({ page }) => {
    await page.goto(
      `${HARNESS_URL}?ai=two&ai_pool=entry&hold_rpc=${encodeURIComponent(method)}#settings/ai-models`,
    );
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect.poll(() => page.evaluate((read) => window.__app.rpcCallCount(read), method))
      .toBeGreaterThan(0);

    const loading = page.getByText('Loading your AI settings.', { exact: true });
    const choices = page.locator('[data-recued-ai-models-model-pref]');
    await expect(loading).toBeVisible();
    await expect(choices).toHaveCount(0);

    const released = await page.evaluate(
      (read) => window.__app.releaseRpcResponses?.(read) ?? 0,
      method,
    );
    expect(released).toBeGreaterThan(0);
    await expect(loading).toHaveCount(0);
    await expect(choices).toHaveCount(3);
    await expect(page.locator('[data-recued-ai-models-rolling-brief]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-recued-ai-models-install-offers]'))
      .toHaveAttribute('aria-pressed', 'true');
  });
}

const chatBehaviourSwitchCases = [
  {
    name: 'rolling brief',
    rpc: 'chat.rolling_brief',
    attr: 'data-recued-ai-models-rolling-brief',
    onLabel: 'Stop keeping a running note',
    offLabel: 'Keep a running note',
  },
  {
    name: 'install offers',
    rpc: 'chat.install_offers',
    attr: 'data-recued-ai-models-install-offers',
    onLabel: 'Stop suggesting packs',
    offLabel: 'Suggest packs',
  },
] as const;

for (const [index, chatSwitch] of chatBehaviourSwitchCases.entries()) {
  const method = `${chatSwitch.rpc}.set`;
  const sibling = chatBehaviourSwitchCases[(index + 1) % chatBehaviourSwitchCases.length]!;

  test(`Settings AI Models ${chatSwitch.name} saves by keyboard and retains focus`, async ({ page }) => {
    await page.goto(`${HARNESS_URL}?ai=two&hold_rpc=${method}#settings/ai-models`);
    await page.waitForFunction(() => window.__app?.ready === true);

    const toggle = page.locator(`[${chatSwitch.attr}]`);
    const other = page.locator(`[${sibling.attr}]`);
    await expect(toggle).toHaveText(chatSwitch.onLabel);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.focus();
    await page.keyboard.press('Enter');

    await expect(toggle).toHaveText('Saving…');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-busy', 'true');
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await expect(toggle).not.toHaveAttribute('disabled');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(1);
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, method)).toBe(1);

    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveText(chatSwitch.offLabel);
    await expect(toggle).not.toHaveAttribute('aria-busy');
    await expect(toggle).not.toHaveAttribute('aria-disabled');
    await expect(toggle).toBeFocused();
    await expect(other).toHaveAttribute('aria-pressed', 'true');

    // Re-mount the page against the same fixture server, rather than relying
    // on the write response still held in the page's in-memory snapshot.
    await page.evaluate(() => window.__app.setHash('#chat'));
    await expect(page.locator('[data-recued-chat-route]')).toHaveCount(1);
    await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
    await expect(toggle).toHaveText(chatSwitch.offLabel);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), `${chatSwitch.rpc}.get`))
      .toBeGreaterThanOrEqual(2);

    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveText('Saving…');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, method)).toBe(1);
    await expect(toggle).toHaveText(chatSwitch.onLabel);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(2);
  });

  test(`Settings AI Models ${chatSwitch.name} failed save stays focused and retryable`, async ({ page }) => {
    await page.goto(
      `${HARNESS_URL}?ai=two&ai_chat_switch_response=fail-first&hold_rpc=${method}#settings/ai-models`,
    );
    await page.waitForFunction(() => window.__app?.ready === true);

    const toggle = page.locator(`[${chatSwitch.attr}]`);
    const error = page.locator('[data-recued-ai-models-action-error]');
    await expect(toggle).toHaveText(chatSwitch.onLabel);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveText('Saving…');
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, method)).toBe(1);

    await expect(error).toHaveText('Chat behaviour update unavailable.');
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveText(chatSwitch.onLabel);
    await expect(toggle).not.toHaveAttribute('aria-busy');
    await expect(toggle).not.toHaveAttribute('aria-disabled');
    await expect(toggle).not.toBeDisabled();
    await expect(toggle).toBeFocused();

    await page.keyboard.press('Space');
    await expect(toggle).toHaveText('Saving…');
    await expect(error).toHaveCount(0);
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, method)).toBe(1);
    await expect(toggle).toHaveText(chatSwitch.offLabel);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toBeFocused();
    await expect(error).toHaveCount(0);
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(2);
  });

  test(`Settings AI Models ${chatSwitch.name} reflects the confirmed server state`, async ({ page }) => {
    await page.goto(
      `${HARNESS_URL}?ai=two&ai_chat_switch_response=unchanged&hold_rpc=${method}#settings/ai-models`,
    );
    await page.waitForFunction(() => window.__app?.ready === true);

    const toggle = page.locator(`[${chatSwitch.attr}]`);
    await expect(toggle).toHaveText(chatSwitch.onLabel);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveText('Saving…');
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, method)).toBe(1);
    await expect(toggle).toHaveText(chatSwitch.onLabel);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).not.toHaveAttribute('aria-busy');
    await expect(toggle).toBeFocused();
    await expect(page.locator('[data-recued-ai-models-action-error]')).toHaveCount(0);
  });

  test(`Settings AI Models ${chatSwitch.name} completion follows the current keyboard focus`, async ({ page, browserName }) => {
    const siblingMethod = `${sibling.rpc}.set`;
    await page.goto(
      `${HARNESS_URL}?ai=two&hold_rpc=${method}&hold_rpc=${siblingMethod}#settings/ai-models`,
    );
    await page.waitForFunction(() => window.__app?.ready === true);

    const toggle = page.locator(`[${chatSwitch.attr}]`);
    const other = page.locator(`[${sibling.attr}]`);
    await expect(toggle).toHaveText(chatSwitch.onLabel);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveText('Saving…');
    await expect(toggle).toBeFocused();

    // Safari's full keyboard navigation includes ordinary buttons.
    const tabKey = index === 0 ? 'Tab' : 'Shift+Tab';
    await page.keyboard.press(browserName === 'webkit' ? `Alt+${tabKey}` : tabKey);
    await expect(other).toBeFocused();
    await page.keyboard.press('Space');
    await expect(other).toHaveText('Saving…');
    await expect(other).toBeFocused();

    // The first response must preserve the second switch's pending state and
    // current focus while the two saves overlap.
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, method)).toBe(1);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(other).toHaveText('Saving…');
    await expect(other).toHaveAttribute('aria-pressed', 'true');
    await expect(other).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, siblingMethod)).toBe(1);
    await expect(other).toHaveText(sibling.offLabel);
    await expect(other).toHaveAttribute('aria-pressed', 'false');
    await expect(other).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(1);
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), siblingMethod)).toBe(1);
  });
}

const aiSettingRefreshCases = [
  {
    name: 'default model', read: 'chat.default_model_pref.get', write: 'chat.default_model_pref.set',
    selector: '[data-recued-ai-models-model-pref="slot_2"]', initial: 'false', confirmed: 'true',
    errorPrefix: 'model preference:',
  },
  {
    name: 'rolling brief', read: 'chat.rolling_brief.get', write: 'chat.rolling_brief.set',
    selector: '[data-recued-ai-models-rolling-brief]', initial: 'true', confirmed: 'false',
    errorPrefix: 'chat behaviour:',
  },
  {
    name: 'pack suggestions', read: 'chat.install_offers.get', write: 'chat.install_offers.set',
    selector: '[data-recued-ai-models-install-offers]', initial: 'true', confirmed: 'false',
    errorPrefix: null,
  },
] as const;
type AiSettingReadRpc = typeof aiSettingRefreshCases[number]['read'];
const beginAiSettingRefresh = async (page: Page, method: AiSettingReadRpc, fail = false) => {
  const count = await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method);
  await page.evaluate(({ method, fail }) => {
    window.__app.holdRpcResponses?.(method);
    if (fail) window.__app.failNextAiSettingsRead?.(method);
    void window.__app.refreshAiModels?.();
  }, { method, fail });
  await expect.poll(() => page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(count + 1);
};
const releaseAiSettingRead = async (page: Page, method: AiSettingReadRpc) => {
  expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, method)).toBe(1);
};
const openAiSettingRefresh = async (page: Page, mobile = false, query = '') => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?ai=two&${query}#settings/ai-models`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
};

for (const [index, setting] of aiSettingRefreshCases.entries()) {
  for (const outcome of ['success', 'failure'] as const) {
    test(`Settings AI Models ${setting.name} refresh keeps a confirmed value after an older ${outcome}`, async ({ page }) => {
      await openAiSettingRefresh(page, index === 2);
      const button = page.locator(setting.selector);
      await expect(button).toHaveAttribute('aria-pressed', setting.initial);
      await button.focus();
      await beginAiSettingRefresh(page, setting.read, outcome === 'failure');
      await expect(button).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(button).toHaveAttribute('aria-pressed', setting.confirmed);
      await expect(button).not.toHaveAttribute('aria-busy');
      await releaseAiSettingRead(page, setting.read);
      await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
      await expect(button).toHaveAttribute('aria-pressed', setting.confirmed);
      await expect(button).toBeFocused();
      await expect(page.getByText('AI setting read unavailable.', { exact: false })).toHaveCount(0);
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), setting.write)).toBe(1);
      expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(0);
    });
  }

  test(`Settings AI Models ${setting.name} refresh can settle while a write is pending without optimistic changes`, async ({ page }) => {
    await openAiSettingRefresh(page, index === 2, `hold_rpc=${setting.write}`);
    const button = page.locator(setting.selector);
    await beginAiSettingRefresh(page, setting.read);
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-pressed', setting.initial);
    await releaseAiSettingRead(page, setting.read);
    await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-pressed', setting.initial);
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), setting.write)).toBe(1);
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, setting.write)).toBe(1);
    await expect(button).toHaveAttribute('aria-pressed', setting.confirmed);
    await expect(button).not.toHaveAttribute('aria-busy');
    await expect(button).not.toHaveAttribute('aria-disabled');
    await expect(button).toBeFocused();
  });

  if (setting.errorPrefix !== null) {
    test(`Settings AI Models ${setting.name} refresh error clears when a later save confirms`, async ({ page }) => {
      await openAiSettingRefresh(page);
      const button = page.locator(setting.selector);
      await beginAiSettingRefresh(page, setting.read, true);
      await releaseAiSettingRead(page, setting.read);
      await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'error');
      const error = page.getByText(`${setting.errorPrefix} AI setting read unavailable.`, { exact: true });
      await expect(error).toBeVisible();
      await button.focus();
      await page.keyboard.press('Space');
      await expect(button).toHaveAttribute('aria-pressed', setting.confirmed);
      await expect(error).toHaveCount(0);
      await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
      await expect(button).toBeFocused();
    });
  }
}

for (const outcome of ['success', 'failure'] as const) {
  test(`Settings AI Models default model refresh keeps a broadcast value after an older ${outcome}`, async ({ page }) => {
    await openAiSettingRefresh(page);
    const button = page.locator(aiSettingRefreshCases[0].selector);
    await button.focus();
    await beginAiSettingRefresh(page, aiSettingRefreshCases[0].read, outcome === 'failure');
    await page.evaluate(() => window.__app.fireMessage({
      type: 'server_event', event: {
        kind: 'chat.default_model_pref_changed', source_id: 'slot_2', updated_at: Number.MAX_SAFE_INTEGER,
      },
    }));
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await releaseAiSettingRead(page, aiSettingRefreshCases[0].read);
    await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toBeFocused();
    expect(await page.evaluate(() => window.__app.rpcCallCount('chat.default_model_pref.set'))).toBe(0);
  });
}

test('Settings AI Models default model refresh error clears after a broadcast confirms the value', async ({ page }) => {
  await openAiSettingRefresh(page);
  const button = page.locator(aiSettingRefreshCases[0].selector);
  await beginAiSettingRefresh(page, aiSettingRefreshCases[0].read, true);
  await releaseAiSettingRead(page, aiSettingRefreshCases[0].read);
  await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'error');
  await button.focus();
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event', event: {
      kind: 'chat.default_model_pref_changed', source_id: 'slot_2', updated_at: Number.MAX_SAFE_INTEGER,
    },
  }));
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
  await expect(page.getByText('model preference: AI setting read unavailable.', { exact: true })).toHaveCount(0);
  await expect(button).toBeFocused();
});

const defaultModelFixtureStamp = 1_700_000_000_000;
const broadcastDefaultModel = async (page: Page, source_id: 'slot_1' | 'slot_2' | 'free_pool', updated_at: number) => {
  await page.evaluate(({ source_id, updated_at }) => window.__app.fireMessage({
    type: 'server_event', event: { kind: 'chat.default_model_pref_changed', source_id, updated_at },
  }), { source_id, updated_at });
};
const openDefaultModelOrdering = async (page: Page, mobile = false, query = '') => {
  await openAiSettingRefresh(page, mobile, `ai_pool=freshness&${query}`);
  return (id: 'slot_1' | 'slot_2' | 'free_pool') => page.locator(`[data-recued-ai-models-model-pref="${id}"]`);
};
const releaseDefaultModelWrite = async (page: Page, count = 1) => {
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('chat.default_model_pref.set'))).toBe(count);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('chat.default_model_pref.set') ?? 0)).toBe(1);
};

for (const mobile of [false, true]) {
  test(`Settings AI Models default model ordering ignores older broadcasts on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
    const choice = await openDefaultModelOrdering(page, mobile);
    await choice('slot_2').focus();
    await broadcastDefaultModel(page, 'slot_2', defaultModelFixtureStamp + 20);
    await expect(choice('slot_2')).toHaveAttribute('aria-pressed', 'true');
    await broadcastDefaultModel(page, 'slot_1', defaultModelFixtureStamp + 10);
    await expect(choice('slot_2')).toHaveAttribute('aria-pressed', 'true');
    await expect(choice('slot_1')).toHaveAttribute('aria-pressed', 'false');
    await expect(choice('slot_2')).toBeFocused();
    // A second real change within that millisecond still applies.
    await broadcastDefaultModel(page, 'free_pool', defaultModelFixtureStamp + 20);
    await expect(choice('free_pool')).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => window.__app.refreshAiModels?.());
    await expect(choice('free_pool')).toHaveAttribute('aria-pressed', 'true');
    await expect(choice('slot_2')).toBeFocused();
    expect(await page.evaluate(() => window.__app.rpcCallCount('chat.default_model_pref.set'))).toBe(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(0);
  });
}

for (const tie of [false, true]) {
  test(`Settings AI Models default model ordering ignores a late ${tie ? 'same-millisecond' : 'older'} save reply and permits a new save`, async ({ page }) => {
    const choice = await openDefaultModelOrdering(page, tie, 'hold_rpc=chat.default_model_pref.set');
    await choice('slot_2').focus();
    await page.keyboard.press('Enter');
    await expect(choice('slot_2')).toHaveAttribute('aria-busy', 'true');
    await broadcastDefaultModel(page, 'free_pool', defaultModelFixtureStamp + (tie ? 1 : 2));
    await expect(choice('free_pool')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Enter');
    await releaseDefaultModelWrite(page);
    await expect(choice('slot_2')).not.toHaveAttribute('aria-busy');
    await expect(choice('slot_2')).not.toHaveAttribute('aria-disabled');
    await expect(choice('free_pool')).toHaveAttribute('aria-pressed', 'true');
    await expect(choice('slot_2')).toBeFocused();
    await page.evaluate(() => window.__app.refreshAiModels?.());
    await expect(choice('free_pool')).toHaveAttribute('aria-pressed', 'true');
    await expect(choice('slot_2')).toBeFocused();
    await choice('slot_1').focus();
    await page.keyboard.press('Space');
    await releaseDefaultModelWrite(page, 2);
    await expect(choice('slot_1')).toHaveAttribute('aria-pressed', 'true');
    await expect(choice('slot_1')).toBeFocused();
    await expect(page.locator('[data-recued-ai-models-action-error]')).toHaveCount(0);
  });
}

test('Settings AI Models default model ordering settles a save acknowledged after its own broadcast', async ({ page }) => {
  const choice = await openDefaultModelOrdering(page, false, 'hold_rpc=chat.default_model_pref.set');
  await choice('slot_2').focus();
  await page.keyboard.press('Enter');
  await expect(choice('slot_2')).toHaveAttribute('aria-busy', 'true');
  await broadcastDefaultModel(page, 'slot_2', defaultModelFixtureStamp + 1);
  await expect(choice('slot_2')).toHaveAttribute('aria-pressed', 'true');
  await expect(choice('slot_2')).toHaveAttribute('aria-busy', 'true');
  await releaseDefaultModelWrite(page);
  await expect(choice('slot_2')).not.toHaveAttribute('aria-busy');
  await expect(choice('slot_2')).not.toHaveAttribute('aria-disabled');
  await expect(choice('slot_2')).toHaveAttribute('aria-pressed', 'true');
  await expect(choice('slot_2')).toBeFocused();
  await expect(page.locator('[data-recued-ai-models-action-error]')).toHaveCount(0);
});

test('Settings AI Models default model ordering leaves a pending read valid after an ignored broadcast', async ({ page }) => {
  const choice = await openDefaultModelOrdering(page);
  await choice('slot_1').focus();
  await beginAiSettingRefresh(page, 'chat.default_model_pref.get');
  await broadcastDefaultModel(page, 'slot_2', defaultModelFixtureStamp - 1);
  await releaseAiSettingRead(page, 'chat.default_model_pref.get');
  await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
  await expect(choice('slot_1')).toHaveAttribute('aria-pressed', 'true');
  await expect(choice('slot_2')).toHaveAttribute('aria-pressed', 'false');
  await expect(choice('slot_1')).toBeFocused();
});

test('Settings AI Models default model ordering cannot hide a read error with an older broadcast', async ({ page }) => {
  const choice = await openDefaultModelOrdering(page, true);
  await choice('slot_2').focus();
  await beginAiSettingRefresh(page, 'chat.default_model_pref.get', true);
  await releaseAiSettingRead(page, 'chat.default_model_pref.get');
  const error = page.getByText('model preference: AI setting read unavailable.', { exact: true });
  await expect(error).toBeVisible();
  await broadcastDefaultModel(page, 'slot_2', defaultModelFixtureStamp - 1);
  await expect(error).toBeVisible();
  await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'error');
  await expect(choice('slot_1')).toHaveAttribute('aria-pressed', 'true');
  await broadcastDefaultModel(page, 'free_pool', defaultModelFixtureStamp + 1);
  await expect(error).toHaveCount(0);
  await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
  await expect(choice('free_pool')).toHaveAttribute('aria-pressed', 'true');
  await expect(choice('slot_2')).toBeFocused();
});

test('Settings AI Models default model ordering permits a same-millisecond save after an earlier read settles', async ({ page }) => {
  const choice = await openDefaultModelOrdering(page, false,
    'ai_default_model_clock=same-ms&hold_rpc=chat.default_model_pref.set');
  await beginAiSettingRefresh(page, 'chat.default_model_pref.get');
  await choice('slot_2').focus();
  await page.keyboard.press('Enter');
  await expect(choice('slot_2')).toHaveAttribute('aria-busy', 'true');
  await releaseAiSettingRead(page, 'chat.default_model_pref.get');
  await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
  await expect(choice('slot_1')).toHaveAttribute('aria-pressed', 'true');
  await releaseDefaultModelWrite(page);
  await expect(choice('slot_2')).toHaveAttribute('aria-pressed', 'true');
  await expect(choice('slot_2')).not.toHaveAttribute('aria-busy');
  await expect(choice('slot_2')).toBeFocused();
});

test('Settings AI Models default model ordering permits a newer save reply after an intermediate broadcast', async ({ page }) => {
  const choice = await openDefaultModelOrdering(page, false,
    'ai_default_model_clock=step-two&hold_rpc=chat.default_model_pref.set');
  await choice('slot_2').focus();
  await page.keyboard.press('Enter');
  await expect(choice('slot_2')).toHaveAttribute('aria-busy', 'true');
  await broadcastDefaultModel(page, 'free_pool', defaultModelFixtureStamp + 1);
  await expect(choice('free_pool')).toHaveAttribute('aria-pressed', 'true');
  await releaseDefaultModelWrite(page);
  await expect(choice('slot_2')).toHaveAttribute('aria-pressed', 'true');
  await expect(choice('slot_2')).toBeFocused();
  await page.evaluate(() => window.__app.refreshAiModels?.());
  await expect(choice('slot_2')).toHaveAttribute('aria-pressed', 'true');
});

test('Settings AI Models controls form full-size keyboard navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?ai=two&ai_pool=entry`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));

  const tabs = page.locator(`[${AI_MODELS_TAB}]`);
  const preference = page.locator(`[${AI_MODELS_TAB}="preference"]`);
  const providers = page.locator(`[${AI_MODELS_TAB}="providers"]`);
  const usage = page.locator(`[${AI_MODELS_TAB}="usage"]`);
  await expect(preference).toHaveAttribute('aria-selected', 'true');
  await expect(preference).toHaveAttribute('tabindex', '0');
  expect(await tabs.evaluateAll((nodes) => nodes.filter(
    (node) => node.getAttribute('tabindex') === '0',
  ).length)).toBe(1);
  const navHeights = await page.locator(`[${SETTINGS_NAV_ITEM}]`).evaluateAll(
    (nodes) => nodes.map((node) => node.getBoundingClientRect().height),
  );
  expect(Math.min(...navHeights)).toBeGreaterThanOrEqual(36);
  const tabHeights = await tabs.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height)
  );
  expect(Math.min(...tabHeights)).toBeGreaterThanOrEqual(36);
  const modelChoices = page.locator('[data-recued-ai-models-model-pref]');
  await expect(modelChoices).toHaveCount(3);
  const choiceHeights = await modelChoices.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height)
  );
  expect(Math.min(...choiceHeights)).toBeGreaterThanOrEqual(36);

  await preference.focus();
  await page.keyboard.press('ArrowRight');
  await expect(providers).toHaveAttribute('aria-selected', 'true');
  await expect(providers).toHaveAttribute('tabindex', '0');
  await expect(providers).toBeFocused();

  const providerDraft = page.locator(
    '[data-recued-ai-models-control="slot_2"]',
  ).getByRole('textbox', { name: 'Model' });
  await providerDraft.fill('draft-model-id');

  await providers.focus();
  await page.keyboard.press('End');
  await expect(usage).toHaveAttribute('aria-selected', 'true');
  await expect(usage).toBeFocused();
  await page.keyboard.press('Home');
  await expect(preference).toHaveAttribute('aria-selected', 'true');
  await expect(preference).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(providers).toBeFocused();
  await expect(providerDraft).toHaveValue('draft-model-id');
});

test('Settings AI Models provider controls expose their owning source', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai=two&ai_pool=entry`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  for (const name of [
    'Slot 1: fast provider name',
    'Slot 2: better, slower thinking provider name',
    'Embeddings slot provider name',
    'New free-pool entry name',
  ]) {
    await expect(page.getByRole('textbox', { name, exact: true })).toHaveCount(1);
  }
  // A protocol is a choice; a provider's name is the owner's word for it.
  for (const name of [
    'Slot 1: fast protocol',
    'Slot 2: better, slower thinking protocol',
    'Embeddings slot protocol',
    'New free-pool entry protocol',
  ]) {
    await expect(page.getByRole('combobox', { name, exact: true })).toHaveCount(1);
  }
  for (const name of [
    'Save Slot 1: fast',
    'Clear Slot 1: fast',
    'Save Slot 2: better, slower thinking',
    'Clear Slot 2: better, slower thinking',
    'Save Embeddings slot',
    'Clear Embeddings slot',
    'Edit free-pool entry groq',
    'Disable free-pool entry groq',
    'Remove free-pool entry groq',
    'Add free-pool API entry',
  ]) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
  }
  for (const name of [
    'Slot 1: fast chat tool catalog',
    'Slot 2: better, slower thinking chat tool catalog',
    'Free pool chat tool catalog',
  ]) {
    await expect(page.getByRole('combobox', { name, exact: true })).toHaveCount(1);
  }
});

test('Settings AI Models preference keeps the selected source focused', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai=two&ai_default_model_pref_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));

  const quality = page.locator(
    '[data-recued-ai-models-model-pref="slot_2"]',
  );
  await expect(quality).toHaveAttribute('aria-pressed', 'false');
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
  await quality.focus();
  await page.keyboard.press('Enter');
  await expect(quality).toHaveText('Selecting Thinking · anthropic…');
  await expect(quality).toHaveAttribute('aria-disabled', 'true');
  await expect(quality).toHaveAttribute('aria-busy', 'true');
  await expect(quality).not.toHaveAttribute('disabled');
  await expect(quality).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#data'));
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'An AI model setting is still updating. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/ai-models$/);
  await quality.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.default_model_pref.set'),
    ),
  ).toBe(1);

  await expect(quality).toHaveAttribute('aria-pressed', 'true');
  await expect(quality).toContainText('Selected:');
  await expect(quality).not.toHaveAttribute('aria-disabled');
  await expect(quality).not.toHaveAttribute('aria-busy');
  await expect(quality).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings AI Models preference failures return to the exact source', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai=two&ai_default_model_pref_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));

  const quality = page.locator(
    '[data-recued-ai-models-model-pref="slot_2"]',
  );
  await quality.focus();
  await page.keyboard.press('Enter');
  await expect(quality).toHaveText('Selecting Thinking · anthropic…');
  await expect(quality).toBeFocused();

  await expect(page.locator('[data-recued-ai-models-action-error]'))
    .toHaveText('Default model preference unavailable.');
  await expect(quality).toHaveText('Thinking · anthropic');
  await expect(quality).toHaveAttribute('aria-pressed', 'false');
  await expect(quality).not.toHaveAttribute('aria-disabled');
  await expect(quality).not.toHaveAttribute('aria-busy');
  await expect(quality).not.toHaveAttribute('disabled');
  await expect(quality).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.default_model_pref.set'),
  )).toBe(1);
});

test('Settings AI Models catalog modes serialize their shared map', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai=two&ai_pool=entry&ai_catalog_mode_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const slotOne = page.locator(
    '[data-recued-ai-models-catalog-mode="slot_1"]',
  );
  const slotTwo = page.locator(
    '[data-recued-ai-models-catalog-mode="slot_2"]',
  );
  await slotOne.focus();
  await slotOne.selectOption('index');

  expect(await page.evaluate(() => {
    const one = document.querySelector<HTMLSelectElement>(
      '[data-recued-ai-models-catalog-mode="slot_1"]',
    )!;
    const two = document.querySelector<HTMLSelectElement>(
      '[data-recued-ai-models-catalog-mode="slot_2"]',
    )!;
    const pending = {
      oneValue: one.value,
      oneAriaDisabled: one.getAttribute('aria-disabled'),
      oneAriaBusy: one.getAttribute('aria-busy'),
      oneNativeDisabled: one.disabled,
      oneFocused: document.activeElement === one,
      twoAriaDisabled: two.getAttribute('aria-disabled'),
    };
    one.value = 'full';
    one.dispatchEvent(new Event('change', { bubbles: true }));
    two.value = 'lean-core';
    two.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      ...pending,
      oneAfterCompetingChange: one.value,
      twoAfterCompetingChange: two.value,
    };
  })).toEqual({
    oneValue: 'index',
    oneAriaDisabled: 'true',
    oneAriaBusy: 'true',
    oneNativeDisabled: false,
    oneFocused: true,
    twoAriaDisabled: 'true',
    oneAfterCompetingChange: 'index',
    twoAfterCompetingChange: '',
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('server.setChatCatalogMode'),
    ),
  ).toBe(1);

  await expect(slotOne).toHaveValue('index');
  await expect(slotOne).not.toHaveAttribute('aria-disabled');
  await expect(slotOne).not.toHaveAttribute('aria-busy');
  await expect(slotTwo).not.toHaveAttribute('aria-disabled');
  await expect(slotOne).toBeFocused();
});

test('Settings AI Models catalog mode failures return to the exact select', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai=two&ai_catalog_mode_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const slotOne = page.locator(
    '[data-recued-ai-models-catalog-mode="slot_1"]',
  );
  await slotOne.focus();
  await slotOne.selectOption('full');
  expect(await slotOne.evaluate((select: HTMLSelectElement) => ({
    value: select.value,
    ariaDisabled: select.getAttribute('aria-disabled'),
    ariaBusy: select.getAttribute('aria-busy'),
    focused: document.activeElement === select,
  }))).toEqual({
    value: 'full',
    ariaDisabled: 'true',
    ariaBusy: 'true',
    focused: true,
  });

  await expect(page.locator('[data-recued-ai-models-action-error]'))
    .toHaveText('Chat catalog mode update unavailable.');
  await expect(slotOne).toHaveValue('');
  await expect(slotOne).not.toHaveAttribute('aria-disabled');
  await expect(slotOne).not.toHaveAttribute('aria-busy');
  await expect(slotOne).not.toBeDisabled();
  await expect(slotOne).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setChatCatalogMode'),
  )).toBe(1);
});

test('Settings AI Models usage actions preserve the budget draft and focus', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai_usage=ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="usage"]`).click();

  const budget = page.getByRole('spinbutton', { name: 'Daily tokens' });
  await expect(budget).toHaveValue('5000');
  await budget.fill('1234');

  const policy = page.locator(
    '[data-recued-ai-models-control="ai_policy"]',
  );
  const allow = policy.getByRole('button', { name: 'May spend my key on its own' });
  await allow.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__app.rpcCallCount('housekeeping.config.write') === 1,
  );
  const disable = policy.getByRole('button', {
    name: 'Do not spend my key on its own',
  });
  await expect(budget).toHaveValue('1234');
  await expect(disable).toBeFocused();

  const save = page.getByRole('button', { name: 'Save budget' });
  await save.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__app.rpcCallCount('server.setConfigField') === 1,
  );
  await expect(budget).toHaveValue('1234');
  await expect(save).toBeFocused();

  const pause = policy.getByRole('button', { name: 'Pause 1h' });
  await pause.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__app.rpcCallCount('housekeeping.config.write') === 2,
  );
  await expect(policy).toContainText('Pause-AI until');
  await expect(pause).toBeFocused();

  const resume = policy.getByRole('button', { name: 'Resume AI' });
  await resume.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__app.rpcCallCount('housekeeping.config.write') === 3,
  );
  await expect(policy).toContainText('AI is not paused.');
  await expect(resume).toBeFocused();
});

test('Settings AI Models policy actions serialize their shared configuration', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai_usage=ready&ai_policy_response=slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="usage"]`).click();

  const policy = page.locator(
    '[data-recued-ai-models-control="ai_policy"]',
  );
  const allow = page.locator(
    '[data-recued-ai-models-allow-byok-toggle="background"]',
  );
  const pause = page.locator('[data-recued-ai-models-pause="1h"]');
  const resume = page.locator('[data-recued-ai-models-pause="resume"]');
  await allow.focus();
  await page.keyboard.press('Enter');

  await expect(allow).toHaveText('Changing…');
  await expect(allow).toHaveAttribute('aria-disabled', 'true');
  await expect(allow).toHaveAttribute('aria-busy', 'true');
  await expect(allow).not.toHaveAttribute('disabled');
  await expect(allow).toBeFocused();
  await expect(pause).toHaveAttribute('aria-disabled', 'true');
  await expect(resume).toHaveAttribute('aria-disabled', 'true');
  await pause.evaluate((button: HTMLElement) => button.click());
  await resume.evaluate((button: HTMLElement) => button.click());
  await allow.evaluate((button: HTMLElement) => button.click());
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('housekeeping.config.write'),
    ),
  ).toBe(1);

  await expect(allow).toHaveText('Do not spend my key on its own');
  await expect(allow).not.toHaveAttribute('aria-disabled');
  await expect(allow).not.toHaveAttribute('aria-busy');
  await expect(pause).not.toHaveAttribute('aria-disabled');
  await expect(resume).not.toHaveAttribute('aria-disabled');
  await expect(allow).toBeFocused();

  await pause.focus();
  await page.keyboard.press('Enter');
  await expect(pause).toHaveText('Pausing AI…');
  await expect(pause).toHaveAttribute('aria-busy', 'true');
  await expect(pause).toBeFocused();
  await resume.evaluate((button: HTMLElement) => button.click());
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('housekeeping.config.write'),
    ),
  ).toBe(2);
  await expect(policy).toContainText('Pause-AI until');
  await expect(pause).toHaveText('Pause 1h');
  await expect(pause).not.toHaveAttribute('aria-busy');
  await expect(pause).toBeFocused();

  await resume.focus();
  await page.keyboard.press('Enter');
  await expect(resume).toHaveText('Resuming AI…');
  await expect(resume).toHaveAttribute('aria-busy', 'true');
  await expect(resume).toBeFocused();
  await pause.evaluate((button: HTMLElement) => button.click());
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('housekeeping.config.write'),
    ),
  ).toBe(3);
  await expect(policy).toContainText('AI is not paused.');
  await expect(resume).toHaveText('Resume AI');
  await expect(resume).not.toHaveAttribute('aria-busy');
  await expect(resume).toBeFocused();
});

test('Settings AI Models policy failures return to the exact command', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai_usage=ready&ai_policy_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="usage"]`).click();

  const policy = page.locator(
    '[data-recued-ai-models-control="ai_policy"]',
  );
  const allow = page.locator(
    '[data-recued-ai-models-allow-byok-toggle="background"]',
  );
  await allow.focus();
  await page.keyboard.press('Enter');
  await expect(allow).toHaveText('Changing…');
  await expect(allow).toBeFocused();

  await expect(page.locator('[data-recued-ai-models-action-error]'))
    .toHaveText('AI usage policy update unavailable.');
  await expect(policy).toContainText('Spending your paid key on its own: free pool only.');
  await expect(allow).toHaveText('May spend my key on its own');
  await expect(allow).not.toHaveAttribute('aria-disabled');
  await expect(allow).not.toHaveAttribute('aria-busy');
  await expect(allow).not.toHaveAttribute('disabled');
  await expect(allow).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('housekeeping.config.write'),
  )).toBe(1);
});

test('Settings AI Models budget Save owns its pending mutation', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai_usage=ready&ai_budget_save_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="usage"]`).click();

  const budget = page.locator(
    '[data-recued-ai-models-budget-input="llm.budget"]',
  );
  const save = page.locator(
    '[data-recued-ai-models-budget-save="llm.budget"]',
  );
  await budget.fill('1234');
  await save.focus();
  await page.keyboard.press('Enter');

  await expect(save).toHaveText('Saving budget…');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  await expect(budget).toHaveAttribute('readonly', '');
  await save.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('server.setConfigField'),
    ),
  ).toBe(1);

  await expect(save).toHaveText('Save budget');
  await expect(save).not.toHaveAttribute('aria-disabled');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).toBeFocused();
  await expect(budget).not.toHaveAttribute('readonly');
  await expect(budget).toHaveValue('1234');
});

test('Settings AI Models budget failures preserve the exact retry draft', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai_usage=ready&ai_budget_save_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="usage"]`).click();

  const budget = page.locator(
    '[data-recued-ai-models-budget-input="llm.budget"]',
  );
  const save = page.locator(
    '[data-recued-ai-models-budget-save="llm.budget"]',
  );
  await budget.fill('4321');
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(save).toHaveText('Saving budget…');
  await expect(save).toBeFocused();

  await expect(page.locator('[data-recued-ai-models-action-error]'))
    .toHaveText('AI budget save unavailable.');
  await expect(budget).toHaveValue('4321');
  await expect(budget).not.toHaveAttribute('readonly');
  await expect(save).toHaveText('Save budget');
  await expect(save).not.toHaveAttribute('aria-disabled');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setConfigField'),
  )).toBe(1);
});

const cacheClearRpc = 'housekeeping.cache.clear';
const cacheStatsRpc = 'housekeeping.cache.stats';

const openAiCacheSettings = async (page: Page, query = '') => {
  await page.goto(`${HARNESS_URL}?settle_reads=1&ai_usage=ready&ai_cache=populated&hold_rpc=${cacheClearRpc}&${query}#settings/ai-models`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const usage = page.locator(`[${AI_MODELS_TAB}="usage"]`);
  await usage.focus();
  await page.keyboard.press('Enter');
  const card = page.getByRole('region', { name: 'LLM result cache', exact: true });
  const clear = card.locator('[data-action="housekeeping-cache-clear"]');
  await expect(clear).toBeVisible();
  return {
    card, clear,
    confirm: card.locator('[data-action="housekeeping-cache-clear-confirm"]'),
    cancel: card.locator('[data-action="housekeeping-cache-clear-cancel"]'),
    budget: page.locator('[data-recued-ai-models-budget-input="llm.budget"]'),
  };
};

const broadcastCacheGc = async (page: Page) => {
  const before = await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), cacheStatsRpc);
  await page.evaluate((at) => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'housekeeping_cycle', at, duration_ms: 5,
      tasks_complete: 1, tasks_yielded: 0, tasks_errored: 0,
      per_task: [{ task_id: 'llm-result-cache-gc', status: 'complete', duration_ms: 5 }],
      cursor: window.__app.rpcCallCount('housekeeping.cache.stats') + 100,
    },
  }), FIXED_NOW);
  await expect.poll(() => page.evaluate((rpc) => window.__app.rpcCallCount(rpc), cacheStatsRpc)).toBe(before + 1);
};

const releaseCacheRpc = async (page: Page, method: string) => {
  expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, method)).toBe(1);
};

for (const size of [
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  test(`Settings AI Models cache focus ${size.name} opens and cancels with either activation key`, async ({ page, browserName }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openAiCacheSettings(page);
    for (const key of ['Enter', 'Space']) {
      await fields.clear.focus();
      await page.keyboard.press(key);
      await expect(fields.cancel).toBeFocused();
      // Match WebKit's macOS keyboard convention for including buttons.
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
      await expect(fields.confirm).toBeFocused();
      await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(fields.cancel).toBeFocused();
      await page.keyboard.press(key);
      await expect(fields.clear).toBeFocused();
    }
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), cacheClearRpc)).toBe(0);
  });

  test(`Settings AI Models cache focus ${size.name} survives card and parent refreshes`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openAiCacheSettings(page);
    await fields.clear.focus();
    await page.evaluate(() => window.__app.refreshAiModels?.());
    await expect(fields.clear).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(fields.cancel).toBeFocused();
    for (const target of [fields.cancel, fields.confirm]) {
      await target.focus();
      await page.evaluate((rpc) => window.__app.holdRpcResponses?.(rpc), cacheStatsRpc);
      await broadcastCacheGc(page);
      await expect(target).toBeFocused();
      await page.evaluate(() => window.__app.refreshAiModels?.());
      await expect(target).toBeFocused();
      await releaseCacheRpc(page, cacheStatsRpc);
      await expect(target).toBeFocused();
    }
    await fields.cancel.focus();
    await page.keyboard.press('Enter');
    await expect(fields.clear).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), cacheClearRpc)).toBe(0);
  });

  test(`Settings AI Models cache focus ${size.name} keeps busy controls until refreshed empty stats`, async ({ page, browserName }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openAiCacheSettings(page);
    await fields.clear.focus();
    await page.keyboard.press('Enter');
    await fields.confirm.focus();
    await page.keyboard.press('Enter');
    await expect(fields.confirm).toHaveText('Clearing…');
    await expect(fields.confirm).toHaveAttribute('aria-busy', 'true');
    await expect(fields.confirm).toHaveAttribute('aria-disabled', 'true');
    await expect(fields.confirm).not.toHaveAttribute('disabled');
    await expect(fields.confirm).toBeFocused();
    await page.keyboard.press('Space');
    await fields.confirm.evaluate((button: HTMLElement) => button.click());
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(fields.cancel).toBeFocused();
    await expect(fields.cancel).toHaveAttribute('aria-disabled', 'true');
    await expect(fields.cancel).not.toHaveAttribute('disabled');
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.__app.refreshAiModels?.());
    await expect(fields.cancel).toBeFocused();
    await page.evaluate((rpc) => window.__app.holdRpcResponses?.(rpc), cacheStatsRpc);
    await releaseCacheRpc(page, cacheClearRpc);
    await expect.poll(() => page.evaluate((rpc) => window.__app.rpcCallCount(rpc), cacheStatsRpc)).toBe(2);
    await expect(fields.confirm).toHaveText('Clearing…');
    await expect(fields.cancel).toBeFocused();
    await fields.confirm.evaluate((button: HTMLElement) => button.click());
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), cacheClearRpc)).toBe(1);
    await releaseCacheRpc(page, cacheStatsRpc);
    await expect(fields.card).toContainText('Currently empty');
    await expect(fields.clear).toHaveCount(0);
    await expect(fields.confirm).toHaveCount(0);
    await expect(fields.card).toHaveAttribute('tabindex', '-1');
    await expect(fields.card).toBeFocused();
    await expect(fields.card).toHaveCSS('outline-style', 'solid');
    await expect(fields.card).toHaveCSS('outline-width', '2px');
    await page.evaluate(() => window.__app.refreshAiModels?.());
    await expect(fields.card).toBeFocused();
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
    await expect(fields.card).not.toBeFocused();
  });

  test(`Settings AI Models cache focus ${size.name} retries a failed clear without duplicate writes`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openAiCacheSettings(page, 'ai_cache_clear_response=fail-first');
    await fields.clear.focus();
    await page.keyboard.press('Enter');
    await fields.confirm.focus();
    await page.keyboard.press('Enter');
    await expect(fields.confirm).toHaveText('Clearing…');
    await expect(fields.confirm).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await fields.cancel.evaluate((button: HTMLElement) => button.click());
    await broadcastCacheGc(page);
    await page.evaluate(() => window.__app.refreshAiModels?.());
    await expect(fields.confirm).toBeFocused();
    await releaseCacheRpc(page, cacheClearRpc);
    await expect(fields.card).toContainText('Cache clear unavailable.');
    await expect(fields.card).toContainText('12');
    await expect(fields.confirm).toHaveText('Confirm clear');
    await expect(fields.confirm).not.toHaveAttribute('aria-disabled');
    await expect(fields.confirm).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), cacheClearRpc)).toBe(1);
    await page.keyboard.press('Enter');
    await expect(fields.confirm).toHaveText('Clearing…');
    await releaseCacheRpc(page, cacheClearRpc);
    await expect(fields.card).toContainText('Currently empty');
    await expect(fields.card).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), cacheClearRpc)).toBe(2);
    await page.evaluate(() => window.__app.setHash('#data'));
    await expect(page).toHaveURL(/#data$/);
    await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
    await page.locator(`[${AI_MODELS_TAB}="usage"]`).click();
    await expect(fields.card).toContainText('Currently empty');
    await expect(fields.clear).toHaveCount(0);
  });

  for (const outcome of ['success', 'failure']) {
    test(`Settings AI Models cache focus ${size.name} leaves a sibling draft owned after ${outcome}`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openAiCacheSettings(page, outcome === 'failure' ? 'ai_cache_clear_response=fail-first' : '');
      await fields.clear.focus();
      await page.keyboard.press('Enter');
      await fields.confirm.focus();
      await page.keyboard.press('Enter');
      await expect(fields.confirm).toHaveText('Clearing…');
      await fields.budget.fill('4321');
      await fields.budget.focus();
      await broadcastCacheGc(page);
      await page.evaluate(() => window.__app.refreshAiModels?.());
      await expect(fields.budget).toBeFocused();
      await releaseCacheRpc(page, cacheClearRpc);
      await expect(fields.card).toContainText(outcome === 'failure' ? 'Cache clear unavailable.' : 'Currently empty');
      await expect(fields.budget).toBeFocused();
      await expect(fields.budget).toHaveValue('4321');
      await page.keyboard.press('End');
      await page.keyboard.type('5');
      await expect(fields.budget).toHaveValue('43215');
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), cacheClearRpc)).toBe(1);
    });
  }

  test(`Settings AI Models cache focus ${size.name} respects a hidden Usage panel`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openAiCacheSettings(page);
    await fields.clear.focus();
    await page.keyboard.press('Enter');
    await fields.confirm.focus();
    await page.keyboard.press('Enter');
    await expect(fields.confirm).toHaveText('Clearing…');
    const providers = page.locator(`[${AI_MODELS_TAB}="providers"]`);
    await providers.focus();
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.__app.refreshAiModels?.());
    await expect(providers).toBeFocused();
    await releaseCacheRpc(page, cacheClearRpc);
    await expect(fields.confirm).toHaveCount(0);
    await expect(providers).toBeFocused();
    const usage = page.locator(`[${AI_MODELS_TAB}="usage"]`);
    await usage.focus();
    await page.keyboard.press('Enter');
    await expect(usage).toBeFocused();
    await expect(fields.card).toContainText('Currently empty');
  });

  test(`Settings AI Models cache focus ${size.name} recovers from a failed post-clear read`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openAiCacheSettings(page);
    await fields.clear.focus();
    await page.keyboard.press('Enter');
    await fields.confirm.focus();
    await page.keyboard.press('Enter');
    await expect(fields.confirm).toHaveText('Clearing…');
    await page.evaluate(() => window.__app.failNextAiSettingsRead?.('housekeeping.cache.stats'));
    await releaseCacheRpc(page, cacheClearRpc);
    await expect(fields.card).toContainText('AI setting read unavailable.');
    await expect(fields.clear).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), cacheClearRpc)).toBe(1);
    await broadcastCacheGc(page);
    await expect(fields.card).toContainText('Currently empty');
    await expect(fields.card).toBeFocused();
    await expect(fields.card).not.toContainText('AI setting read unavailable.');
  });

  test(`Settings AI Models cache focus ${size.name} returns to the summary when GC empties a confirmation`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openAiCacheSettings(page);
    await fields.clear.focus();
    await page.keyboard.press('Enter');
    await expect(fields.cancel).toBeFocused();
    await page.evaluate(() => window.__app.setAiCacheEntries?.(0));
    await broadcastCacheGc(page);
    await expect(fields.card).toContainText('Currently empty');
    await expect(fields.cancel).toHaveCount(0);
    await expect(fields.card).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), cacheClearRpc)).toBe(0);
  });

  test(`Settings AI Models cache focus ${size.name} reports a failed clear after concurrent GC emptied the cache`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openAiCacheSettings(page, 'ai_cache_clear_response=fail-first');
    await fields.clear.focus();
    await page.keyboard.press('Enter');
    await fields.confirm.focus();
    await page.keyboard.press('Enter');
    await expect(fields.confirm).toHaveText('Clearing…');
    await page.evaluate(() => window.__app.setAiCacheEntries?.(0));
    await broadcastCacheGc(page);
    await expect(fields.card.locator('.housekeeping-cache-card-rollup dd').first()).toHaveText('0');
    await expect(fields.confirm).toHaveAttribute('aria-disabled', 'true');
    await expect(fields.confirm).toBeFocused();
    await page.keyboard.press('Enter');
    await releaseCacheRpc(page, cacheClearRpc);
    await expect(fields.card).toContainText('Currently empty');
    await expect(fields.card).toContainText('Cache clear unavailable.');
    await expect(fields.confirm).toHaveCount(0);
    await expect(fields.card).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), cacheClearRpc)).toBe(1);
  });
}

test('Settings AI Models prompt editing preserves focus and caret', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));

  await page.locator(`[${AI_MODELS_TAB}="prompts"]`).click();
  const prompt = page.getByRole('textbox', {
    name: 'Chat system prompt',
    exact: true,
  });
  await expect(prompt).toBeVisible();
  const initial = await prompt.inputValue();
  await prompt.focus();
  await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 3));
  await page.keyboard.type('XY');
  await expect(prompt).toHaveValue(`${initial.slice(0, 3)}XY${initial.slice(3)}`);
  await expect(prompt).toBeFocused();
  expect(await prompt.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(5);

  // The status line is mutated in place on input — it must NOT have cost the
  // caret, which is the whole reason typing does not re-render.
  await expect(page.locator(`[${AI_MODELS_PROMPT_STATUS}="chat"]`))
    .toHaveText('You have not saved yet. Save to make this happen.');
  await expect(prompt).toBeFocused();
  expect(await prompt.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(5);

  const save = page.getByRole('button', {
    name: 'Save Chat system prompt',
    exact: true,
  });
  await save.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__app.rpcCallCount('server.setLlmPrompt') === 1,
  );
  await expect(page.locator(
    `[${AI_MODELS_PROMPT_SECTION}="chat"] [${AI_MODELS_PROMPT_BADGE}="custom"]`,
  )).toBeVisible();
  await expect(save).toBeFocused();
});

test('Settings AI Models prompt Save owns its reload round trip', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai_prompt_save_response=slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="prompts"]`).click();

  const prompt = page.locator(`[${AI_MODELS_PROMPT_TEXT}="chat"]`);
  const save = page.locator(`[${AI_MODELS_PROMPT_SAVE}="chat"]`);
  const loadDefault = page.locator(`[${AI_MODELS_PROMPT_LOAD_DEFAULT}="chat"]`);
  const status = page.locator(`[${AI_MODELS_PROMPT_STATUS}="chat"]`);
  await prompt.fill('A durable owner-authored prompt.');
  await expect(status).toHaveText('You have not saved yet. Save to make this happen.');
  await save.focus();
  await page.keyboard.press('Enter');

  await expect(save).toHaveText('Saving…');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  await expect(prompt).toHaveAttribute('readonly', '');
  await expect(loadDefault).toHaveAttribute('aria-disabled', 'true');
  await expect(loadDefault).not.toHaveAttribute('disabled');
  await save.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  // `Load default` is client-only, so nothing but its own guard stops it
  // repainting the box out from under the in-flight save.
  await loadDefault.evaluate((button: HTMLElement) => button.click());
  await expect(prompt).toHaveValue('A durable owner-authored prompt.');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('server.setLlmPrompt'),
    ),
  ).toBe(1);

  await expect(page.locator(
    `[${AI_MODELS_PROMPT_SECTION}="chat"] [${AI_MODELS_PROMPT_BADGE}="custom"]`,
  )).toBeVisible();
  await expect(prompt).toHaveValue('A durable owner-authored prompt.');
  await expect(prompt).not.toHaveAttribute('readonly');
  await expect(status).toHaveText('This is yours. It is in use now.');
  await expect(save).toHaveText('Save');
  await expect(save).not.toHaveAttribute('aria-disabled');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).toBeFocused();

  // …and the reset the removed button used to do, in two visible steps: the
  // built-in lands in the box for the owner to READ, and only Save commits it.
  await loadDefault.focus();
  await page.keyboard.press('Enter');
  await expect(prompt).toHaveValue(
    'You are Recued. You speak in plain, calm prose.',
  );
  await expect(status).toHaveText('You have not saved yet. Save to make this happen.');
  await expect(loadDefault).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setLlmPrompt'),
  )).toBe(1);

  await save.evaluate((button: HTMLElement) => button.click());
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('server.setLlmPrompt'),
    ),
  ).toBe(2);

  // Badge back to Default ⇒ the save sent `null` and the server DELETED the
  // row. A byte-identical copy would still read "Customised" here.
  await expect(page.locator(
    `[${AI_MODELS_PROMPT_SECTION}="chat"] [${AI_MODELS_PROMPT_BADGE}="default"]`,
  )).toBeVisible();
  await expect(prompt).toHaveValue(
    'You are Recued. You speak in plain, calm prose.',
  );
  await expect(prompt).not.toHaveAttribute('readonly');
  await expect(status).toHaveText('This is the one Recued comes with. It is in use now.');
  await expect(loadDefault).toHaveText('Use the one Recued comes with');
  await expect(loadDefault).not.toHaveAttribute('aria-disabled');
});

test('Settings AI Models prompt failures preserve the exact retry draft', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai_prompt_save_response=fail-slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="prompts"]`).click();

  const prompt = page.locator(`[${AI_MODELS_PROMPT_TEXT}="chat"]`);
  const save = page.locator(`[${AI_MODELS_PROMPT_SAVE}="chat"]`);
  const status = page.locator(`[${AI_MODELS_PROMPT_STATUS}="chat"]`);
  await prompt.fill('Keep this exact failed-save draft.');
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(save).toHaveText('Saving…');
  await expect(save).toBeFocused();

  await expect(page.locator('[data-recued-ai-models-action-error]'))
    .toHaveText('System prompt save unavailable.');
  await expect(prompt).toHaveValue('Keep this exact failed-save draft.');
  await expect(prompt).not.toHaveAttribute('readonly');
  // The draft survived, so it is still unsaved — the status line has to keep
  // saying so, or a failed save reads as a successful one.
  await expect(status).toHaveText('You have not saved yet. Save to make this happen.');
  await expect(save).toHaveText('Save');
  await expect(save).not.toHaveAttribute('aria-disabled');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setLlmPrompt'),
  )).toBe(1);
});

test('Settings AI Models slot actions preserve sibling drafts and action focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?ai_slot_save_response=slow&ai_slot_clear_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));

  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();
  const slotOne = page.locator(
    '[data-recued-ai-models-control="slot_1"]',
  );
  const slotTwo = page.locator(
    '[data-recued-ai-models-control="slot_2"]',
  );
  const siblingDraft = slotTwo.getByRole('textbox', { name: 'Model' });
  await siblingDraft.fill('draft-model-id');

  const save = slotOne.locator(
    '[data-recued-ai-models-slot-save="slot_1"]',
  );
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(save).toHaveText('Saving slot…');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  await expect(slotOne.getByRole('textbox', { name: 'Model' }))
    .toHaveAttribute('readonly', '');
  await save.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('server.setLLMSlot')),
  ).toBe(1);

  await expect(siblingDraft).toHaveValue('draft-model-id');
  await expect(save).toHaveText('Save slot');
  await expect(save).not.toHaveAttribute('aria-disabled');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).toBeFocused();

  const clear = slotOne.getByRole('button', { name: 'Clear slot' });
  await clear.focus();
  await page.keyboard.press('Enter');
  const clearDialog = page.locator(
    `[${AI_MODELS_SLOT_CLEAR_DIALOG}="slot_1"]`,
  );
  await expect(clearDialog).toBeVisible();
  await expect(clearDialog.getByRole('button', { name: 'Cancel' }))
    .toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setLLMSlot'),
  )).toBe(1);
  const confirmClear = clearDialog.locator(
    `[${AI_MODELS_SLOT_CLEAR_CONFIRM}="slot_1"]`,
  );
  const cancelClear = clearDialog.locator(
    `[${AI_MODELS_SLOT_CLEAR_CANCEL}="slot_1"]`,
  );
  await page.keyboard.press('Shift+Tab');
  await expect(confirmClear).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__app.rpcCallCount('server.setLLMSlot') === 2,
  );
  await expect(clearDialog).toHaveAttribute('aria-busy', 'true');
  await expect(confirmClear).toHaveText('Clearing slot…');
  await expect(confirmClear).toHaveAttribute('aria-disabled', 'true');
  await expect(confirmClear).toHaveAttribute('aria-busy', 'true');
  await expect(confirmClear).not.toHaveAttribute('disabled');
  await expect(confirmClear).toBeFocused();
  await expect(cancelClear).toHaveAttribute('aria-disabled', 'true');
  await expect(cancelClear).not.toHaveAttribute('disabled');
  await confirmClear.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await cancelClear.evaluate((button: HTMLElement) => button.click());
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setLLMSlot'),
  )).toBe(2);
  await expect(clearDialog).toBeVisible();
  await expect(clearDialog).toHaveCount(0);
  await expect(slotOne).toContainText('Not set up.');
  await expect(siblingDraft).toHaveValue('draft-model-id');
  await expect(clear).toBeFocused();
});

test('Settings AI Models Clear slot starts safely and Cancel returns to its command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const slot = page.locator('[data-recued-ai-models-control="slot_1"]');
  const clear = slot.getByRole('button', { name: 'Clear slot' });
  await clear.focus();
  await page.keyboard.press('Enter');

  const dialog = page.locator(
    `[${AI_MODELS_SLOT_CLEAR_DIALOG}="slot_1"]`,
  );
  await expect(dialog).toHaveRole('alertdialog');
  await expect(dialog).toHaveAccessibleName('Clear Slot 1: fast?');
  await expect(dialog).toContainText(
    'This deletes the settings and the key from this Recued server.',
  );
  const cancel = dialog.locator(
    `[${AI_MODELS_SLOT_CLEAR_CANCEL}="slot_1"]`,
  );
  await expect(cancel).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setLLMSlot'),
  )).toBe(0);

  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(clear).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setLLMSlot'),
  )).toBe(0);
});

test('Settings AI Models failed Clear slot stays owned and retryable', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai_slot_clear_response=fail-slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const slot = page.locator('[data-recued-ai-models-control="slot_1"]');
  const clear = slot.getByRole('button', { name: 'Clear slot' });
  await clear.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator(
    `[${AI_MODELS_SLOT_CLEAR_DIALOG}="slot_1"]`,
  );
  const confirm = dialog.locator(
    `[${AI_MODELS_SLOT_CLEAR_CONFIRM}="slot_1"]`,
  );
  const cancel = dialog.locator(
    `[${AI_MODELS_SLOT_CLEAR_CANCEL}="slot_1"]`,
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Clearing slot…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toBeFocused();
  await confirm.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await cancel.evaluate((button: HTMLElement) => button.click());
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setLLMSlot'),
  )).toBe(1);
  await expect(dialog).toBeVisible();

  await expect(page.locator('[data-recued-ai-models-action-error]'))
    .toHaveText('Model slot clear unavailable.');
  await expect(dialog).toContainText('Model slot clear unavailable.');
  await expect(confirm).toHaveText('Clear slot');
  await expect(confirm).not.toHaveAttribute('aria-disabled');
  await expect(confirm).not.toHaveAttribute('aria-busy');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(slot).not.toContainText('Not set up.');

  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(clear).toBeFocused();
});

test('Set up Chat sends a provider it does not name to slot 1 and slot 2', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai=empty`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models/setup/start'));

  const setup = page.locator(`[${CHAT_SETUP}]`);
  const link = setup.getByRole('link', { name: 'Set up slot 1 and slot 2' });
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(/#settings\/ai-models\/providers$/);
  await expect(page.locator(`[${AI_MODELS_TAB}="providers"]`))
    .toHaveAttribute('aria-selected', 'true');
  const slot = page.locator('[data-recued-ai-models-control="slot_1"]');
  await expect(slot.getByRole('textbox', { name: 'Slot 1: fast provider name' })).toBeVisible();
  await expect(slot.getByRole('combobox', { name: 'Slot 1: fast protocol' })).toBeVisible();
});

test('Settings AI Models slot mistakes are said under the button that was pressed', async ({ page }, info) => {
  await page.goto(`${HARNESS_URL}?ai=two`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models/providers'));

  // slot_2 is saved as Anthropic with a key. A new protocol is a new address,
  // so a blank key field there is not the saved key.
  const slot = page.locator('[data-recued-ai-models-control="slot_2"]');
  await slot.getByRole('textbox', { name: 'Slot 2: better, slower thinking provider name' })
    .fill('Groq');
  await slot.getByRole('combobox', { name: 'Slot 2: better, slower thinking protocol' })
    .selectOption('openai-compatible');
  const test = slot.locator('[data-recued-ai-models-slot-test="slot_2"]');
  await test.click();
  const testError = slot.locator('[data-recued-ai-models-form-error="slot_2:test"]');
  await expect(testError).toHaveText(
    'OpenAI-compatible needs a base URL, such as https://api.groq.com/openai/v1.',
  );

  await slot.getByRole('textbox', { name: 'Slot 2: better, slower thinking base URL' })
    .fill('https://api.groq.com/openai/v1');
  const save = slot.locator('[data-recued-ai-models-slot-save="slot_2"]');
  await save.click();
  const saveError = slot.locator('[data-recued-ai-models-form-error="slot_2:save"]');
  await expect(saveError).toHaveText(
    'You changed where this key goes, so enter it again. A saved key is never sent to a new address.',
  );
  // The answer to the latest press only: the base URL is filled in now.
  await expect(testError).toHaveCount(0);
  await expect(saveError).toHaveAttribute('role', 'alert');
  // Below the buttons, in the danger colour, and nothing in the page banner.
  const [saveBox, errorBox] = await Promise.all([save.boundingBox(), saveError.boundingBox()]);
  expect(errorBox!.y).toBeGreaterThan(saveBox!.y + saveBox!.height - 0.5);
  const [errorColor, dangerColor, textColor] = await saveError.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger)';
    el.appendChild(probe);
    const colors = [
      getComputedStyle(el).color,
      getComputedStyle(probe).color,
      getComputedStyle(document.body).color,
    ];
    probe.remove();
    return colors;
  });
  expect(errorColor).toBe(dangerColor);
  // Not vacuous: an undefined token would make both the inherited text colour.
  expect(errorColor).not.toBe(textColor);
  await expect(page.locator('[data-recued-ai-models-action-error]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.setLLMSlot'))).toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(0);
  await page.screenshot({ path: info.outputPath('full-app-ai-slot-inline-errors.png'), fullPage: true });

  // With the key for the new address the save goes, carrying the name.
  await slot.getByRole('textbox', { name: 'Slot 2: better, slower thinking API key' })
    .fill('gsk-e2e-only');
  await save.click();
  await expect(saveError).toHaveCount(0);
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('server.setLLMSlot')),
  ).toBe(1);
  await expect(slot).toContainText('Groq (OpenAI-compatible) / claude-sonnet-test');
});

test('Settings AI Models slot save failures return to the exact draft', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai_slot_save_response=fail-slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const slot = page.locator('[data-recued-ai-models-control="slot_1"]');
  const model = slot.getByRole('textbox', { name: 'Model' });
  await model.fill('retry-model-id');
  const save = slot.locator(
    '[data-recued-ai-models-slot-save="slot_1"]',
  );
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(save).toHaveText('Saving slot…');
  await expect(save).toBeFocused();

  // Under the slot's own buttons, where the owner is looking after the click.
  await expect(slot.locator('[data-recued-ai-models-form-error="slot_1:save"]'))
    .toHaveText('Model slot save unavailable.');
  await expect(page.locator('[data-recued-ai-models-action-error]')).toHaveCount(0);
  await expect(model).toHaveValue('retry-model-id');
  await expect(model).not.toHaveAttribute('readonly');
  await expect(save).toHaveText('Save slot');
  await expect(save).not.toHaveAttribute('aria-disabled');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setLLMSlot'),
  )).toBe(1);
});

test('Settings AI Models pool actions preserve drafts and action focus', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai_pool=entry&ai_pool_toggle_response=slow&ai_pool_add_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const pool = page.locator(
    '[data-recued-ai-models-control="free_pool"]',
  );
  const add = pool.locator('.ai-models-add-pool');
  const draftId = add.locator(
    '[data-recued-ai-models-pool-add-field="id"]',
  );
  const draftModel = add.locator(
    '[data-recued-ai-models-pool-add-field="model"]',
  );
  const draftKey = add.locator(
    '[data-recued-ai-models-pool-add-field="api-key"]',
  );
  await draftId.fill('draft-entry');
  await draftModel.fill('draft-model');
  await draftKey.fill('draft-secret');
  // The default protocol is OpenAI-compatible, which needs its address.
  await add.locator('[data-recued-ai-models-pool-add-field="base-url"]')
    .fill('https://api.groq.com/openai/v1');

  const toggle = pool.locator(
    '[data-recued-ai-models-pool-toggle="groq"]',
  );
  await toggle.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__app.rpcCallCount('server.setFreePoolEntryEnabled') === 1,
  );
  const remove = pool.locator(
    '[data-recued-ai-models-pool-remove="groq"]',
  );
  await expect(toggle).toHaveText('Disabling…');
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).not.toHaveAttribute('disabled');
  await expect(toggle).toBeFocused();
  await expect(remove).toHaveAttribute('aria-disabled', 'true');
  await expect(remove).not.toHaveAttribute('disabled');
  await toggle.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await remove.evaluate((button: HTMLElement) => button.click());
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setFreePoolEntryEnabled'),
  )).toBe(1);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);

  await expect(draftId).toHaveValue('draft-entry');
  await expect(draftModel).toHaveValue('draft-model');
  await expect(draftKey).toHaveValue('draft-secret');
  await expect(toggle).toHaveText('Enable');
  await expect(toggle).toBeFocused();

  const addEntry = add.locator('[data-recued-ai-models-pool-add]');
  await addEntry.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__app.rpcCallCount('server.upsertFreePoolEntry') === 1,
  );
  await expect(addEntry).toHaveText('Adding entry…');
  await expect(addEntry).toHaveAttribute('aria-disabled', 'true');
  await expect(addEntry).toHaveAttribute('aria-busy', 'true');
  await expect(addEntry).not.toHaveAttribute('disabled');
  await expect(addEntry).toBeFocused();
  await expect(draftId).toHaveAttribute('readonly', '');
  await expect(draftKey).toHaveAttribute('readonly', '');
  await addEntry.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.upsertFreePoolEntry'),
  )).toBe(1);
  await expect(draftId).toHaveValue('draft-entry');
  await expect(draftModel).toHaveValue('draft-model');
  await expect(draftKey).toHaveValue('draft-secret');
  await expect(pool.locator(
    '[data-recued-ai-models-control="free_pool:draft-entry"]',
  )).toContainText('draft-model');
  await expect(draftId).toHaveValue('');
  await expect(draftModel).toHaveValue('');
  await expect(draftKey).toHaveValue('');
  await expect(addEntry).toHaveText('Add API entry');
  await expect(addEntry).not.toHaveAttribute('aria-disabled');
  await expect(addEntry).not.toHaveAttribute('aria-busy');
  await expect(addEntry).toBeFocused();
});

test('Settings AI Models pool entries are named, tested, and edited in place', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai_pool=entry`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models/providers'));

  const pool = page.locator('[data-recued-ai-models-control="free_pool"]');
  const form = pool.locator('.ai-models-add-pool');
  // Left unnamed, it is named from its address, clear of the "groq" there.
  await form.getByRole('combobox', { name: 'New free-pool entry protocol', exact: true })
    .selectOption('openai-compatible');
  await form.getByRole('textbox', { name: 'New free-pool entry base URL', exact: true })
    .fill('https://api.groq.com/openai/v1');
  await form.getByRole('textbox', { name: 'New free-pool entry model', exact: true })
    .fill('llama-3.1-8b-instant');
  await form.locator('[data-recued-ai-models-pool-add-field="api-key"]').fill('gsk-e2e-only');
  // Tested before it is added.
  await form.getByRole('button', { name: 'Test the new free-pool entry connection', exact: true })
    .click();
  await expect(form.locator('[data-recued-ai-models-slot-test-result="free_pool:form"]'))
    .toHaveAttribute('data-probe-ok', 'true');
  await form.getByRole('button', { name: 'Add free-pool API entry', exact: true }).click();

  const added = pool.locator('[data-recued-ai-models-control="free_pool:groq-2"]');
  await expect(added).toContainText('groq-2: OpenAI-compatible / llama-3.1-8b-instant (enabled)');
  for (const name of [
    'Edit free-pool entry groq-2',
    'Disable free-pool entry groq-2',
    'Remove free-pool entry groq-2',
    'Test the free-pool entry groq-2 connection',
  ]) {
    await expect(added.getByRole('button', { name, exact: true })).toHaveCount(1);
  }

  // Edit opens the form on the entry, focus with it, and saves in place.
  await added.getByRole('button', { name: 'Edit free-pool entry groq-2', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Edit groq-2' })).toBeVisible();
  await expect(form.getByRole('combobox', { name: 'Free-pool entry groq-2 protocol', exact: true }))
    .toBeFocused();
  await form.getByRole('textbox', { name: 'Free-pool entry groq-2 model', exact: true })
    .fill('llama-3.3-70b-versatile');
  await page.screenshot({ path: test.info().outputPath(`full-app-ai-pool-edit.png`), fullPage: true });
  await form.getByRole('button', { name: 'Save free-pool entry groq-2', exact: true }).click();

  await expect(added).toContainText('groq-2: OpenAI-compatible / llama-3.3-70b-versatile (enabled)');
  await expect(added.getByRole('button', { name: 'Edit free-pool entry groq-2', exact: true }))
    .toBeFocused();
  await expect(form.getByRole('heading', { name: 'Add a free one' })).toBeVisible();
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.upsertFreePoolEntry')))
    .toBe(2);
});

test('Settings AI Models pool removal keeps the destructive command owned', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai_pool=entry&ai_pool_remove_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const remove = page.locator(
    '[data-recued-ai-models-pool-remove="groq"]',
  );
  await remove.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator(
    '[data-recued-ai-models-pool-remove-dialog="groq"]',
  );
  const cancel = dialog.locator(
    '[data-recued-ai-models-pool-remove-cancel="groq"]',
  );
  const confirm = dialog.locator(
    '[data-recued-ai-models-pool-remove-confirm="groq"]',
  );
  await expect(dialog).toHaveRole('alertdialog');
  await expect(cancel).toBeFocused();
  await confirm.focus();
  await page.keyboard.press('Enter');

  await expect(dialog).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).toHaveText('Removing…');
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
  await cancel.evaluate((button: HTMLElement) => button.click());
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('server.removeFreePoolEntry'),
    ),
  ).toBe(1);

  await expect(dialog).toHaveCount(0);
  await expect(remove).toHaveCount(0);
  await expect(page.locator('[data-recued-ai-models-pool-add]'))
    .toBeFocused();
});

test('Settings AI Models failed pool removal stays owned and retryable', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai_pool=entry&ai_pool_remove_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const remove = page.locator(
    '[data-recued-ai-models-pool-remove="groq"]',
  );
  await remove.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator(
    '[data-recued-ai-models-pool-remove-dialog="groq"]',
  );
  const confirm = dialog.locator(
    '[data-recued-ai-models-pool-remove-confirm="groq"]',
  );
  const cancel = dialog.locator(
    '[data-recued-ai-models-pool-remove-cancel="groq"]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Removing…');
  await expect(confirm).toBeFocused();

  await expect(page.locator('[data-recued-ai-models-action-error]'))
    .toHaveText('Free-pool entry removal unavailable.');
  await expect(dialog).toContainText('Free-pool entry removal unavailable.');
  await expect(confirm).toHaveText('Remove entry');
  await expect(confirm).not.toHaveAttribute('aria-disabled');
  await expect(confirm).not.toHaveAttribute('aria-busy');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(remove).toBeVisible();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.removeFreePoolEntry'),
  )).toBe(1);

  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
});

test('Settings AI Models pool toggle failures preserve its sibling draft', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai_pool=entry&ai_pool_toggle_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const pool = page.locator('[data-recued-ai-models-control="free_pool"]');
  const draft = pool.locator(
    '[data-recued-ai-models-pool-add-field="model"]',
  );
  await draft.fill('retry-pool-model');
  const toggle = pool.locator(
    '[data-recued-ai-models-pool-toggle="groq"]',
  );
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveText('Disabling…');
  await expect(toggle).toBeFocused();

  await expect(page.locator('[data-recued-ai-models-action-error]'))
    .toHaveText('Free-pool entry update unavailable.');
  await expect(draft).toHaveValue('retry-pool-model');
  await expect(toggle).toHaveText('Disable');
  await expect(toggle).not.toHaveAttribute('aria-disabled');
  await expect(toggle).not.toHaveAttribute('aria-busy');
  await expect(toggle).not.toHaveAttribute('disabled');
  await expect(toggle).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setFreePoolEntryEnabled'),
  )).toBe(1);
});

test('Settings AI Models pool Add failures preserve the exact secret draft', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai_pool_add_response=fail-slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const add = page.locator('.ai-models-add-pool');
  const id = add.locator('[data-recued-ai-models-pool-add-field="id"]');
  const model = add.locator(
    '[data-recued-ai-models-pool-add-field="model"]',
  );
  const key = add.locator(
    '[data-recued-ai-models-pool-add-field="api-key"]',
  );
  await id.fill('retry-entry');
  await model.fill('retry-model');
  await key.fill('retry-secret');
  await add.locator('[data-recued-ai-models-pool-add-field="base-url"]')
    .fill('https://api.groq.com/openai/v1');
  const submit = add.locator('[data-recued-ai-models-pool-add]');
  await submit.focus();
  await page.keyboard.press('Enter');
  await expect(submit).toHaveText('Adding entry…');
  await expect(submit).toBeFocused();

  // Under the form's own buttons, not in the page banner.
  await expect(add.locator('[data-recued-ai-models-form-error="free_pool:form:save"]'))
    .toHaveText('Free-pool entry save unavailable.');
  await expect(page.locator('[data-recued-ai-models-action-error]')).toHaveCount(0);
  await expect(id).toHaveValue('retry-entry');
  await expect(model).toHaveValue('retry-model');
  await expect(key).toHaveValue('retry-secret');
  await expect(key).not.toHaveAttribute('readonly');
  await expect(submit).toHaveText('Add API entry');
  await expect(submit).not.toHaveAttribute('aria-disabled');
  await expect(submit).not.toHaveAttribute('aria-busy');
  await expect(submit).not.toHaveAttribute('disabled');
  await expect(submit).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.upsertFreePoolEntry'),
  )).toBe(1);
});

const editableProbeSources = [
  { key: 'slot_1', title: 'BYOK', label: 'Slot 1: fast', write: 'server.setLLMSlot' },
  { key: 'embeddings_slot', title: 'Embeddings', label: 'Embeddings slot', write: 'server.setEmbeddingsSlot' },
] as const;

const openEditableProbeSettings = async (
  page: Page,
  source: typeof editableProbeSources[number],
  query: string,
) => {
  if (source.key === 'embeddings_slot') await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?ai=two&ai_embeddings=configured&${query}#settings/ai-models`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const providers = page.locator(`[${AI_MODELS_TAB}="providers"]`);
  await providers.focus();
  await page.keyboard.press('Enter');
  const card = page.locator(`[data-recued-ai-models-control="${source.key}"]`);
  await expect(card).toBeVisible();
  const field = (name: string) => card.locator(source.key === 'embeddings_slot'
    ? `[data-recued-ai-models-embeddings-field="${name}"]`
    : `[data-recued-ai-models-slot-field="${source.key}:${name}"]`);
  return {
    card, field,
    model: field('model'),
    key: field('api-key'),
    test: card.getByRole('button', { name: `Test the ${source.label} connection`, exact: true }),
    save: card.getByRole('button', { name: `Save ${source.label}`, exact: true }),
    clear: card.getByRole('button', { name: `Clear ${source.label}`, exact: true }),
    probe: card.locator(`[data-recued-ai-models-slot-test-result="${source.key}"]`),
    testError: card.locator(`[data-recued-ai-models-form-error="${source.key}:test"]`),
  };
};

const releaseEditableProbeRpc = async (page: Page, method: string, count: number) => {
  await expect.poll(() => page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(count);
  expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, method)).toBe(1);
};

for (const source of editableProbeSources) {
  const heldProbe = 'hold_rpc=server.probeLlmSource';
  const probeRpc = 'server.probeLlmSource';

  test(`Settings AI Models ${source.title} probe tests drafts explicitly and reports source-specific facts`, async ({ page }) => {
    const fields = await openEditableProbeSettings(page, source, `${heldProbe}&ai_source_probe=success`);
    await fields.model.fill('unsaved-probe-model');
    await fields.key.fill('source-fixture-key');
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(0);
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await expect(fields.test).toHaveText('Testing…');
    await expect(fields.test).toHaveAttribute('aria-busy', 'true');
    await expect(fields.test).toHaveAttribute('aria-disabled', 'true');
    await expect(fields.test).not.toHaveAttribute('disabled');
    await expect(fields.test).toBeFocused();
    await releaseEditableProbeRpc(page, probeRpc, 1);
    await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
    await expect(fields.probe).toHaveAttribute('role', 'status');
    await expect(fields.probe).toContainText('answered in 120 ms');
    if (source.key === 'embeddings_slot') await expect(fields.probe).toContainText('1536-dimension vectors');
    else await expect(fields.probe).not.toContainText('dimension vectors');
    await expect(fields.probe.locator('[data-recued-ai-models-probe-transcript]')).toHaveCount(0);
    await expect(fields.test).toBeFocused();
    await expect(fields.model).toHaveValue('unsaved-probe-model');
    await expect(fields.key).toHaveValue('source-fixture-key');
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), source.write)).toBe(0);
  });

  for (const mode of ['success', 'rejected-first', 'rpc-fail-first']) {
    test(`Settings AI Models ${source.title} probe ignores a stale ${mode} reply after an edit`, async ({ page }) => {
      const fields = await openEditableProbeSettings(page, source, `${heldProbe}&ai_source_probe=${mode}`);
      await fields.key.fill('source-fixture-key');
      await fields.test.focus();
      await page.keyboard.press('Enter');
      await expect(fields.test).toHaveText('Testing…');
      await fields.model.fill('edited-probe-model');
      await fields.test.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      const siblingKey = source.key === 'slot_1' ? 'embeddings_slot' : 'slot_1';
      const siblingTest = page.locator(`[data-recued-ai-models-slot-test="${siblingKey}"]`);
      await expect(siblingTest).toHaveAttribute('aria-disabled', 'true');
      await siblingTest.evaluate((button: HTMLElement) => button.click());
      await fields.model.focus();
      await fields.model.evaluate((input: HTMLInputElement) => input.setSelectionRange(5, 5));
      await releaseEditableProbeRpc(page, probeRpc, 1);
      await expect(fields.test).toHaveText('Test connection');
      await expect(fields.test).not.toHaveAttribute('aria-busy');
      await expect(siblingTest).not.toHaveAttribute('aria-disabled');
      await expect(fields.probe).toHaveCount(0);
      await expect(fields.testError).toHaveCount(0);
      await expect(fields.model).toHaveValue('edited-probe-model');
      await expect(fields.model).toBeFocused();
      expect(await fields.model.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([5, 5]);
      expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
      await fields.test.focus();
      await page.keyboard.press('Enter');
      await releaseEditableProbeRpc(page, probeRpc, 2);
      await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
      await expect(fields.probe).toContainText('answered in 240 ms');
      await expect(fields.test).toBeFocused();
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), source.write)).toBe(0);
    });
  }

  for (const { mode, field, value } of [
    { mode: 'success', field: 'model', value: 'edited-probe-model' },
    { mode: 'success', field: 'provider', value: 'openai-compatible' },
    { mode: 'success', field: 'base-url', value: 'https://probe.example.test/v1' },
    { mode: 'success', field: 'api-key', value: 'edited-fixture-key' },
    { mode: 'rejected-first', field: 'model', value: 'edited-probe-model' },
    { mode: 'rpc-fail-first', field: 'model', value: 'edited-probe-model' },
  ]) {
    test(`Settings AI Models ${source.title} probe removes a completed ${mode} answer after ${field} changes`, async ({ page }) => {
      const fields = await openEditableProbeSettings(page, source, `${heldProbe}&ai_source_probe=${mode}`);
      await fields.test.focus();
      await page.keyboard.press('Enter');
      await releaseEditableProbeRpc(page, probeRpc, 1);
      if (mode === 'rpc-fail-first') await expect(fields.testError).toHaveText('Source probe transport unavailable.');
      else {
        await expect(fields.probe).toHaveAttribute('data-probe-ok', mode === 'success' ? 'true' : 'false');
        if (mode === 'rejected-first') await expect(fields.probe).toContainText('The fixture source endpoint refused the key.');
      }
      const input = fields.field(field);
      const originalInput = await input.elementHandle();
      await input.focus();
      if (field === 'provider') await input.selectOption(value);
      else await input.fill(value);
      await expect(fields.probe).toHaveCount(0);
      await expect(fields.testError).toHaveCount(0);
      await expect(input).toBeFocused();
      expect(await originalInput!.evaluate((element) => element.isConnected)).toBe(true);
      if (field !== 'provider') {
        await page.keyboard.type('-continued');
        await expect(input).toHaveValue(`${value}-continued`);
      }
      expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
    });
  }

  for (const action of ['Save', 'Clear'] as const) {
    for (const failWrite of [false, true]) {
      test(`Settings AI Models ${source.title} probe discards a pending answer when ${action} starts (${failWrite ? 'failed' : 'successful'} write)`, async ({ page }) => {
        const response = source.key === 'slot_1' ? 'ai_slot' : 'ai_embeddings';
        const fields = await openEditableProbeSettings(page, source,
          `${heldProbe}&ai_source_probe=success&hold_rpc=${source.write}`
          + (failWrite ? `&${response}_${action.toLowerCase()}_response=fail-slow` : ''));
        await fields.key.fill('source-fixture-key');
        const originalModel = await fields.model.inputValue();
        await fields.test.focus();
        await page.keyboard.press('Enter');
        await expect(fields.test).toHaveText('Testing…');
        let owner = fields.save;
        const dialog = page.locator(`[${AI_MODELS_SLOT_CLEAR_DIALOG}="${source.key}"]`);
        if (action === 'Save') {
          await fields.save.focus();
          await page.keyboard.press('Enter');
          await expect(fields.save).toHaveText('Saving slot…');
        } else {
          await fields.clear.focus();
          await page.keyboard.press('Enter');
          owner = dialog.locator(`[${AI_MODELS_SLOT_CLEAR_CONFIRM}="${source.key}"]`);
          await page.keyboard.press('Shift+Tab');
          await expect(owner).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(dialog).toHaveAttribute('aria-busy', 'true');
        }
        await releaseEditableProbeRpc(page, probeRpc, 1);
        await expect(fields.test).toHaveText('Test connection');
        await expect(fields.probe).toHaveCount(0);
        await expect(fields.testError).toHaveCount(0);
        await expect(owner).toHaveAttribute('aria-busy', 'true');
        await expect(owner).toBeFocused();
        await releaseEditableProbeRpc(page, source.write, 1);
        if (failWrite) {
          if (action === 'Clear') {
            await expect(dialog).toContainText(source.key === 'slot_1' ? 'Model slot clear unavailable.' : 'Embeddings slot clear unavailable.');
            await dialog.locator(`[${AI_MODELS_SLOT_CLEAR_CANCEL}="${source.key}"]`).focus();
            await page.keyboard.press('Enter');
            await expect(dialog).toHaveCount(0);
          } else await expect(fields.card.locator(`[data-recued-ai-models-form-error="${source.key}:save"]`)).toBeVisible();
          await expect(fields.model).toHaveValue(originalModel);
          await fields.test.focus();
          await page.keyboard.press('Enter');
          await releaseEditableProbeRpc(page, probeRpc, 2);
          await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
        } else {
          await expect(fields.model).toHaveValue(action === 'Clear' ? '' : originalModel);
          await expect(action === 'Clear' ? fields.clear : fields.save).toBeFocused();
          await expect(fields.probe).toHaveCount(0);
          expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
        }
      });
    }

    test(`Settings AI Models ${source.title} probe removes a completed answer as ${action} starts`, async ({ page }) => {
      const fields = await openEditableProbeSettings(page, source, `${heldProbe}&ai_source_probe=success&hold_rpc=${source.write}`);
      await fields.key.fill('source-fixture-key');
      await fields.test.focus();
      await page.keyboard.press('Enter');
      await releaseEditableProbeRpc(page, probeRpc, 1);
      await expect(fields.probe).toBeVisible();
      if (action === 'Save') {
        await fields.save.focus();
        await page.keyboard.press('Enter');
        await expect(fields.save).toHaveText('Saving slot…');
      } else {
        await fields.clear.focus();
        await page.keyboard.press('Enter');
        const dialog = page.locator(`[${AI_MODELS_SLOT_CLEAR_DIALOG}="${source.key}"]`);
        await page.keyboard.press('Shift+Tab');
        await expect(dialog.locator(`[${AI_MODELS_SLOT_CLEAR_CONFIRM}="${source.key}"]`)).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(dialog).toHaveAttribute('aria-busy', 'true');
      }
      await expect(fields.probe).toHaveCount(0);
      await releaseEditableProbeRpc(page, source.write, 1);
      await expect(fields.probe).toHaveCount(0);
      expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
    });
  }

  test(`Settings AI Models ${source.title} probe stays valid when Clear is cancelled`, async ({ page }) => {
    const fields = await openEditableProbeSettings(page, source, `${heldProbe}&ai_source_probe=success`);
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await fields.clear.focus();
    await page.keyboard.press('Enter');
    const dialog = page.locator(`[${AI_MODELS_SLOT_CLEAR_DIALOG}="${source.key}"]`);
    await expect(dialog.locator(`[${AI_MODELS_SLOT_CLEAR_CANCEL}="${source.key}"]`)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await releaseEditableProbeRpc(page, probeRpc, 1);
    await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
    await expect(fields.clear).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), source.write)).toBe(0);
  });

  test(`Settings AI Models ${source.title} probe preserves display and limit drafts outside the request`, async ({ page }) => {
    const fields = await openEditableProbeSettings(page, source, `${heldProbe}&ai_source_probe=success`);
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await fields.field('provider-name').fill('My renamed source');
    if (source.key === 'slot_1') {
      await fields.field('daily-budget').fill('2500');
      await fields.field('context-window').fill('64000');
    }
    const focusedField = source.key === 'slot_1' ? fields.field('context-window') : fields.field('provider-name');
    await releaseEditableProbeRpc(page, probeRpc, 1);
    await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
    await expect(focusedField).toBeFocused();
    await expect(fields.field('provider-name')).toHaveValue('My renamed source');
    await fields.field('provider-name').fill('Another display name');
    await expect(fields.probe).toBeVisible();
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
  });

  test(`Settings AI Models ${source.title} probe stays valid when a sibling source saves`, async ({ page }) => {
    const fields = await openEditableProbeSettings(page, source, `${heldProbe}&ai_source_probe=success`);
    await fields.test.focus();
    await page.keyboard.press('Enter');
    const sibling = page.locator('[data-recued-ai-models-control="slot_2"]');
    await sibling.locator('[data-recued-ai-models-slot-field="slot_2:model"]').fill('sibling-draft');
    await sibling.locator('[data-recued-ai-models-slot-field="slot_2:api-key"]').fill('sibling-fixture-key');
    await sibling.getByRole('button', { name: 'Save Slot 2: better, slower thinking', exact: true }).click();
    await expect(sibling).toContainText('sibling-draft');
    await fields.model.focus();
    await releaseEditableProbeRpc(page, probeRpc, 1);
    await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
    await expect(fields.model).toBeFocused();
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
  });
}

const poolProbeRpc = 'server.probeLlmSource';
const poolWriteRpc = 'server.upsertFreePoolEntry';
const openFreePoolProbeSettings = async (page: Page, mode: 'add' | 'edit', query: string) => {
  if (mode === 'edit') await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?ai=two&ai_pool=freshness&hold_rpc=${poolProbeRpc}&${query}#settings/ai-models`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).focus();
  await page.keyboard.press('Enter');
  const pool = page.locator('[data-recued-ai-models-control="free_pool"]');
  const form = pool.locator('.ai-models-add-pool');
  const field = (name: string) => form.locator(`[data-recued-ai-models-pool-add-field="${name}"]`);
  const row = (id: string) => pool.locator(`[data-recued-ai-models-control="free_pool:${id}"]`);
  const edit = (id: string) => row(id).getByRole('button', { name: `Edit free-pool entry ${id}`, exact: true });
  await field('id').fill('new-source');
  await field('model').fill('new-model');
  await field('api-key').fill('pool-fixture-key');
  await field('base-url').fill('https://new.example.test/v1');
  if (mode === 'edit') {
    await edit('groq').focus();
    await page.keyboard.press('Enter');
    await expect(form.getByRole('heading', { name: 'Edit groq', exact: true })).toBeVisible();
  }
  return {
    pool, form, field, row, edit,
    model: field('model'), key: field('api-key'),
    test: form.locator('[data-recued-ai-models-slot-test="free_pool:form"]'),
    submit: form.locator(mode === 'add' ? '[data-recued-ai-models-pool-add]' : '[data-recued-ai-models-pool-save="groq"]'),
    probe: form.locator('[data-recued-ai-models-slot-test-result="free_pool:form"]'),
    error: form.locator('[data-recued-ai-models-form-error="free_pool:form:test"]'),
  };
};

const poolToggleRpc = 'server.setFreePoolEntryEnabled';
const openFreePoolWriteSettings = async (page: Page, enabled: boolean, query = '') => {
  await page.goto(`${HARNESS_URL}?ai=two&ai_pool=freshness&hold_rpc=${poolWriteRpc}${enabled ? `&hold_rpc=${poolToggleRpc}` : ''}&${query}#settings/ai-models`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const providers = page.locator(`[${AI_MODELS_TAB}="providers"]`);
  await providers.focus();
  await page.keyboard.press('Enter');
  const pool = page.locator('[data-recued-ai-models-control="free_pool"]');
  const form = pool.locator('.ai-models-add-pool');
  const row = (id: string) => pool.locator(`[data-recued-ai-models-control="free_pool:${id}"]`);
  const toggle = (id: string) => row(id).locator(`[data-recued-ai-models-pool-toggle="${id}"]`);
  if (!enabled) {
    await toggle('groq').focus();
    await page.keyboard.press('Enter');
    await expect(row('groq')).toContainText('(disabled)');
    await expect(toggle('groq')).not.toHaveAttribute('aria-busy');
    await page.evaluate((rpc) => window.__app.holdRpcResponses?.(rpc), poolToggleRpc);
  }
  return { pool, form, row, toggle, providers, toggleBase: enabled ? 0 : 1 };
};

const remountFreePoolAndCheck = async (
  page: Page,
  fields: Awaited<ReturnType<typeof openFreePoolWriteSettings>>,
  enabled: boolean,
  model: string,
) => {
  for (const revisit of [false, true]) {
    if (revisit) {
      await page.evaluate(() => window.__app.setHash('#data'));
      await expect(page.locator('[data-recued-data-route]')).toHaveCount(1);
      await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
      await expect(page.locator('[data-recued-ai-models-page-state]')).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
      await fields.providers.focus();
      await page.keyboard.press('Enter');
    }
    await expect(fields.row('groq')).toContainText(enabled ? '(enabled)' : '(disabled)');
    await expect(fields.row('groq')).toContainText(model);
  }
};

for (const size of [
  { name: 'desktop', viewport: { width: 1360, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  for (const { enabled, outcome } of [
    { enabled: true, outcome: 'success' },
    { enabled: true, outcome: 'failure' },
    { enabled: false, outcome: 'success' },
  ] as const) {
    const action = enabled ? 'disable' : 'enable';
    test(`Settings AI Models Free-pool write ownership ${size.name} edit before ${action} (${outcome})`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openFreePoolWriteSettings(page, enabled, outcome === 'failure' ? 'ai_pool_add_response=fail-slow' : '');
      await fields.row('groq').getByRole('button', { name: 'Edit free-pool entry groq', exact: true }).click();
      const model = fields.form.locator('[data-recued-ai-models-pool-add-field="model"]');
      await model.fill('serialized-model');
      const save = fields.form.locator('[data-recued-ai-models-pool-save="groq"]');
      await save.focus();
      await page.keyboard.press('Enter');
      await expect(save).toHaveAttribute('aria-busy', 'true');
      const toggle = fields.toggle('groq');
      const remove = fields.row('groq').locator('[data-recued-ai-models-pool-remove="groq"]');
      await expect(toggle).toHaveAttribute('aria-disabled', 'true');
      await expect(toggle).not.toHaveAttribute('aria-busy');
      await expect(toggle).not.toHaveAttribute('disabled');
      await expect(remove).toHaveAttribute('aria-disabled', 'true');
      await toggle.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await toggle.evaluate((button: HTMLElement) => button.click());
      await remove.evaluate((button: HTMLElement) => button.click());
      await expect(toggle).toBeFocused();
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), poolToggleRpc)).toBe(fields.toggleBase);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, poolWriteRpc)).toBe(1);
      if (outcome === 'failure') {
        await expect(fields.form.locator('[data-recued-ai-models-form-error="free_pool:form:save"]'))
          .toHaveText('Free-pool entry save unavailable.');
        await expect(model).toHaveValue('serialized-model');
        await expect(model).not.toHaveAttribute('readonly');
      } else await expect(save).toHaveCount(0);
      await expect(toggle).not.toHaveAttribute('aria-disabled');
      await expect(toggle).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-busy', 'true');
      expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, poolToggleRpc)).toBe(1);
      await expect(toggle).not.toHaveAttribute('aria-busy');
      await expect(toggle).toBeFocused();
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), poolWriteRpc)).toBe(1);
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), poolToggleRpc)).toBe(fields.toggleBase + 1);
      await remountFreePoolAndCheck(page, fields, !enabled, outcome === 'success' ? 'serialized-model' : 'llama-free');
    });

    test(`Settings AI Models Free-pool write ownership ${size.name} ${action} before edit (${outcome})`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openFreePoolWriteSettings(page, enabled, outcome === 'failure' ? 'ai_pool_toggle_response=fail-slow' : '');
      await fields.row('groq').getByRole('button', { name: 'Edit free-pool entry groq', exact: true }).click();
      const model = fields.form.locator('[data-recued-ai-models-pool-add-field="model"]');
      await model.fill('serialized-model');
      const probe = fields.form.locator('[data-recued-ai-models-slot-test-result="free_pool:form"]');
      await fields.form.locator('[data-recued-ai-models-slot-test="free_pool:form"]').click();
      await expect(probe).toHaveAttribute('data-probe-ok', 'true');
      const toggle = fields.toggle('groq');
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-busy', 'true');
      const save = fields.form.locator('[data-recued-ai-models-pool-save="groq"]');
      await expect(save).toHaveAttribute('aria-disabled', 'true');
      await expect(save).not.toHaveAttribute('aria-busy');
      await expect(save).not.toHaveAttribute('disabled');
      await save.focus();
      await page.keyboard.press('Enter');
      await save.evaluate((button: HTMLElement) => button.click());
      await expect(save).toBeFocused();
      await expect(probe).toHaveAttribute('data-probe-ok', 'true');
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), poolWriteRpc)).toBe(0);
      await model.fill('continued-model');
      await model.evaluate((input: HTMLInputElement) => input.setSelectionRange(4, 4));
      await expect(model).not.toHaveAttribute('readonly');
      expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, poolToggleRpc)).toBe(1);
      await expect(toggle).not.toHaveAttribute('aria-busy');
      await expect(save).not.toHaveAttribute('aria-disabled');
      await expect(model).toHaveValue('continued-model');
      await expect(model).toBeFocused();
      expect(await model.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([4, 4]);
      if (outcome === 'failure') {
        await expect(page.locator('[data-recued-ai-models-action-error]')).toHaveText('Free-pool entry update unavailable.');
      }
      await save.focus();
      await page.keyboard.press('Enter');
      await expect(save).toHaveAttribute('aria-busy', 'true');
      expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, poolWriteRpc)).toBe(1);
      await expect(save).toHaveCount(0);
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), poolWriteRpc)).toBe(1);
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), poolToggleRpc)).toBe(fields.toggleBase + 1);
      await remountFreePoolAndCheck(page, fields, outcome === 'success' ? !enabled : enabled, 'continued-model');
    });
  }

  test(`Settings AI Models Free-pool write ownership ${size.name} permits sibling changes through refresh`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openFreePoolWriteSettings(page, true);
    await fields.row('groq').getByRole('button', { name: 'Edit free-pool entry groq', exact: true }).click();
    await fields.form.locator('[data-recued-ai-models-pool-add-field="model"]').fill('serialized-model');
    const save = fields.form.locator('[data-recued-ai-models-pool-save="groq"]');
    await save.focus();
    await page.keyboard.press('Enter');
    await expect(save).toHaveAttribute('aria-busy', 'true');
    await page.evaluate(() => window.__app.refreshAiModels?.());
    await expect(fields.toggle('groq')).toHaveAttribute('aria-disabled', 'true');
    const sibling = fields.toggle('mistral');
    await expect(sibling).not.toHaveAttribute('aria-disabled');
    await sibling.focus();
    await page.keyboard.press('Enter');
    await expect(sibling).toHaveAttribute('aria-busy', 'true');
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, poolToggleRpc)).toBe(1);
    await expect(fields.row('mistral')).toContainText('(disabled)');
    await expect(sibling).toBeFocused();
    await expect(save).toHaveAttribute('aria-busy', 'true');
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, poolWriteRpc)).toBe(1);
    await expect(save).toHaveCount(0);
    await expect(sibling).toBeFocused();
    await remountFreePoolAndCheck(page, fields, true, 'serialized-model');
    await expect(fields.row('mistral')).toContainText('(disabled)');
  });

  test(`Settings AI Models Free-pool write ownership ${size.name} protects an added row revealed by refresh`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openFreePoolWriteSettings(page, true);
    for (const [field, value] of [
      ['id', 'new-source'], ['model', 'new-model'], ['api-key', 'pool-fixture-key'],
      ['base-url', 'https://new.example.test/v1'],
    ]) await fields.form.locator(`[data-recued-ai-models-pool-add-field="${field}"]`).fill(value!);
    const add = fields.form.locator('[data-recued-ai-models-pool-add]');
    await add.focus();
    await page.keyboard.press('Enter');
    await expect(add).toHaveAttribute('aria-busy', 'true');
    await page.evaluate(() => window.__app.refreshAiModels?.());
    const toggle = fields.toggle('new-source');
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await toggle.focus();
    await page.keyboard.press('Enter');
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), poolToggleRpc)).toBe(0);
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, poolWriteRpc)).toBe(1);
    await expect(add).not.toHaveAttribute('aria-busy');
    await expect(toggle).not.toHaveAttribute('aria-disabled');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-busy', 'true');
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, poolToggleRpc)).toBe(1);
    await expect(fields.row('new-source')).toContainText('(disabled)');
    await remountFreePoolAndCheck(page, fields, true, 'llama-free');
    await expect(fields.row('new-source')).toContainText('(disabled)');
  });
}

for (const mode of ['add', 'edit'] as const) {
  for (const outcome of ['success', 'rejected-first', 'rpc-fail-first']) {
    test(`Settings AI Models Free-pool ${mode} probe ignores a stale ${outcome} reply after an edit`, async ({ page }) => {
      const fields = await openFreePoolProbeSettings(page, mode, `ai_source_probe=${outcome}`);
      await fields.test.focus();
      await page.keyboard.press('Enter');
      await expect(fields.test).toHaveText('Testing…');
      await expect(fields.test).toBeFocused();
      await fields.model.fill('edited-pool-model');
      await fields.test.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      const siblingTest = fields.row('mistral').locator('[data-recued-ai-models-slot-test="pool:mistral"]');
      await expect(siblingTest).toHaveAttribute('aria-disabled', 'true');
      await siblingTest.evaluate((button: HTMLElement) => button.click());
      await fields.model.focus();
      await fields.model.evaluate((input: HTMLInputElement) => input.setSelectionRange(5, 5));
      await releaseEditableProbeRpc(page, poolProbeRpc, 1);
      await expect(fields.test).toHaveText('Test connection');
      await expect(fields.probe).toHaveCount(0);
      await expect(fields.error).toHaveCount(0);
      await expect(fields.model).toHaveValue('edited-pool-model');
      await expect(fields.model).toBeFocused();
      expect(await fields.model.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([5, 5]);
      await expect(siblingTest).not.toHaveAttribute('aria-disabled');
      expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
      await fields.test.focus();
      await page.keyboard.press('Enter');
      await releaseEditableProbeRpc(page, poolProbeRpc, 2);
      await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
      await expect(fields.probe).toContainText('answered in 240 ms');
      await expect(fields.test).toBeFocused();
      expect(await page.evaluate(() => window.__app.rpcCallCount('server.upsertFreePoolEntry'))).toBe(0);
    });
  }

  for (const { outcome, field, value } of [
    { outcome: 'success', field: 'model', value: 'edited-pool-model' },
    { outcome: 'success', field: 'provider', value: 'openai' },
    { outcome: 'success', field: 'base-url', value: 'https://changed.example.test/v1' },
    { outcome: 'success', field: 'api-key', value: 'changed-fixture-key' },
    ...(mode === 'add' ? [{ outcome: 'success', field: 'id', value: 'renamed-target' }] : []),
    { outcome: 'rejected-first', field: 'model', value: 'edited-pool-model' },
    { outcome: 'rpc-fail-first', field: 'model', value: 'edited-pool-model' },
  ]) {
    test(`Settings AI Models Free-pool ${mode} probe clears a completed ${outcome} answer after ${field} changes`, async ({ page }) => {
      const fields = await openFreePoolProbeSettings(page, mode, `ai_source_probe=${outcome}`);
      await fields.test.focus();
      await page.keyboard.press('Enter');
      await releaseEditableProbeRpc(page, poolProbeRpc, 1);
      if (outcome === 'rpc-fail-first') await expect(fields.error).toHaveText('Source probe transport unavailable.');
      else await expect(fields.probe).toHaveAttribute('data-probe-ok', outcome === 'success' ? 'true' : 'false');
      const input = fields.field(field);
      const original = await input.elementHandle();
      await input.focus();
      if (field === 'provider') await input.selectOption(value);
      else await input.fill(value);
      await expect(fields.probe).toHaveCount(0);
      await expect(fields.error).toHaveCount(0);
      await expect(input).toBeFocused();
      expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
      if (field !== 'provider') {
        await page.keyboard.type('-continued');
        await expect(input).toHaveValue(`${value}-continued`);
      }
      expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
    });
  }

  for (const failWrite of [false, true]) {
    test(`Settings AI Models Free-pool ${mode} probe discards a pending answer when its write starts (${failWrite ? 'failed' : 'successful'} write)`, async ({ page }) => {
      const fields = await openFreePoolProbeSettings(page, mode,
        `ai_source_probe=success&hold_rpc=${poolWriteRpc}${failWrite ? '&ai_pool_add_response=fail-slow' : ''}`);
      const originalModel = await fields.model.inputValue();
      const originalKey = await fields.key.inputValue();
      await fields.test.focus();
      await page.keyboard.press('Enter');
      await fields.submit.focus();
      await page.keyboard.press('Enter');
      await expect(fields.submit).toHaveAttribute('aria-busy', 'true');
      await releaseEditableProbeRpc(page, poolProbeRpc, 1);
      await expect(fields.probe).toHaveCount(0);
      await expect(fields.error).toHaveCount(0);
      await expect(fields.submit).toBeFocused();
      await expect(fields.submit).toHaveAttribute('aria-busy', 'true');
      await releaseEditableProbeRpc(page, poolWriteRpc, 1);
      await expect(fields.probe).toHaveCount(0);
      if (failWrite) {
        await expect(fields.form.locator('[data-recued-ai-models-form-error="free_pool:form:save"]')).toHaveText('Free-pool entry save unavailable.');
        await expect(fields.model).toHaveValue(originalModel);
        await expect(fields.key).toHaveValue(originalKey);
        await fields.test.focus();
        await page.keyboard.press('Enter');
        await releaseEditableProbeRpc(page, poolProbeRpc, 2);
        await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
      } else {
        await expect(fields.model).toHaveValue(mode === 'add' ? '' : 'new-model');
        await expect(mode === 'add' ? fields.submit : fields.edit('groq')).toBeFocused();
        expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
      }
    });
  }

  test(`Settings AI Models Free-pool ${mode} probe started during a write cannot answer the reset form`, async ({ page }) => {
    const fields = await openFreePoolProbeSettings(page, mode, `ai_source_probe=success&hold_rpc=${poolWriteRpc}`);
    await fields.submit.focus();
    await page.keyboard.press('Enter');
    await expect(fields.submit).toHaveAttribute('aria-busy', 'true');
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await expect(fields.test).toHaveText('Testing…');
    await releaseEditableProbeRpc(page, poolWriteRpc, 1);
    await expect(fields.form.getByRole('heading', { name: 'Add a free one', exact: true })).toBeVisible();
    await releaseEditableProbeRpc(page, poolProbeRpc, 1);
    await expect(fields.probe).toHaveCount(0);
    await expect(fields.error).toHaveCount(0);
    await expect(fields.model).toHaveValue(mode === 'add' ? '' : 'new-model');
  });

  test(`Settings AI Models Free-pool ${mode} probe clears a completed answer as its write starts`, async ({ page }) => {
    const fields = await openFreePoolProbeSettings(page, mode, `ai_source_probe=success&hold_rpc=${poolWriteRpc}`);
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await releaseEditableProbeRpc(page, poolProbeRpc, 1);
    await expect(fields.probe).toBeVisible();
    await fields.submit.focus();
    await page.keyboard.press('Enter');
    await expect(fields.submit).toHaveAttribute('aria-busy', 'true');
    await expect(fields.probe).toHaveCount(0);
    await releaseEditableProbeRpc(page, poolWriteRpc, 1);
    await expect(fields.probe).toHaveCount(0);
  });

  test(`Settings AI Models Free-pool ${mode} probe keeps context-limit edits outside the request`, async ({ page }) => {
    const fields = await openFreePoolProbeSettings(page, mode, 'ai_source_probe=success');
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await fields.field('context-window').fill('64000');
    await releaseEditableProbeRpc(page, poolProbeRpc, 1);
    await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
    await expect(fields.field('context-window')).toHaveValue('64000');
    await expect(fields.field('context-window')).toBeFocused();
    await fields.field('context-window').fill('128000');
    await expect(fields.probe).toBeVisible();
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
  });
}

for (const transition of ['add-to-edit', 'edit-to-edit', 'Cancel'] as const) {
  for (const outcome of ['success', 'rejected-first', 'rpc-fail-first']) {
    test(`Settings AI Models Free-pool probe ignores a stale ${outcome} reply across ${transition}`, async ({ page }) => {
      const fields = await openFreePoolProbeSettings(page, transition === 'add-to-edit' ? 'add' : 'edit', `ai_source_probe=${outcome}`);
      await fields.test.focus();
      await page.keyboard.press('Enter');
      if (transition === 'Cancel') {
        await fields.form.getByRole('button', { name: 'Stop editing free-pool entry groq', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(fields.edit('groq')).toBeFocused();
      } else {
        await fields.edit(transition === 'add-to-edit' ? 'groq' : 'mistral').focus();
        await page.keyboard.press('Enter');
        await expect(fields.field('provider')).toBeFocused();
      }
      await fields.model.focus();
      await fields.model.evaluate((input: HTMLInputElement) => input.setSelectionRange(3, 3));
      const currentModel = await fields.model.inputValue();
      await releaseEditableProbeRpc(page, poolProbeRpc, 1);
      await expect(fields.probe).toHaveCount(0);
      await expect(fields.error).toHaveCount(0);
      await expect(fields.model).toHaveValue(currentModel);
      await expect(fields.model).toBeFocused();
      expect(await fields.model.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([3, 3]);
      if (transition === 'Cancel') await expect(fields.key).toHaveValue('pool-fixture-key');
      await fields.test.focus();
      await page.keyboard.press('Enter');
      await releaseEditableProbeRpc(page, poolProbeRpc, 2);
      await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
      await expect(fields.probe).toContainText('answered in 240 ms');
      expect(await page.evaluate(() => window.__app.rpcCallCount('server.upsertFreePoolEntry'))).toBe(0);
    });
  }
}

test('Settings AI Models Free-pool probe stays stale after switching away and back to the same entry', async ({ page }) => {
  const fields = await openFreePoolProbeSettings(page, 'edit', 'ai_source_probe=success');
  await fields.test.click();
  await fields.edit('mistral').click();
  await fields.edit('groq').click();
  await releaseEditableProbeRpc(page, poolProbeRpc, 1);
  await expect(fields.probe).toHaveCount(0);
  await expect(fields.error).toHaveCount(0);
  await expect(fields.model).toHaveValue('llama-free');
});

test('Settings AI Models Free-pool stored-row probes are invalidated as their entry saves', async ({ page }) => {
  const fields = await openFreePoolProbeSettings(page, 'add', `ai_source_probe=success&hold_rpc=${poolWriteRpc}`);
  const rowProbe = fields.row('groq').locator('[data-recued-ai-models-slot-test-result="pool:groq"]');
  const rowTest = fields.row('groq').getByRole('button', { name: 'Test the free-pool entry groq connection', exact: true });
  await rowTest.click();
  await fields.edit('groq').click();
  await fields.model.fill('changed-saved-model');
  const save = fields.form.getByRole('button', { name: 'Save free-pool entry groq', exact: true });
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await releaseEditableProbeRpc(page, poolProbeRpc, 1);
  await expect(rowProbe).toHaveCount(0);
  await expect(save).toBeFocused();
  await releaseEditableProbeRpc(page, poolWriteRpc, 1);
  await expect(fields.row('groq')).toContainText('changed-saved-model');
  await expect(fields.edit('groq')).toBeFocused();
  await rowTest.click();
  await releaseEditableProbeRpc(page, poolProbeRpc, 2);
  await expect(rowProbe).toContainText('answered in 240 ms');
  await fields.edit('groq').click();
  await fields.model.fill('another-saved-model');
  await expect(rowProbe).toBeVisible();
  await save.click();
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(rowProbe).toHaveCount(0);
  await releaseEditableProbeRpc(page, poolWriteRpc, 2);
  await expect(rowProbe).toHaveCount(0);
});

test('Settings AI Models Free-pool stored-row probes survive unsaved edits, Cancel, toggles, and sibling saves', async ({ page }) => {
  const fields = await openFreePoolProbeSettings(page, 'add', 'ai_source_probe=success');
  await fields.row('groq').getByRole('button', { name: 'Test the free-pool entry groq connection', exact: true }).click();
  await fields.edit('groq').click();
  await fields.model.fill('unsaved-model');
  await fields.form.getByRole('button', { name: 'Stop editing free-pool entry groq', exact: true }).click();
  await fields.row('groq').getByRole('button', { name: 'Disable free-pool entry groq', exact: true }).click();
  await fields.edit('mistral').click();
  await fields.model.fill('sibling-model');
  await fields.form.getByRole('button', { name: 'Save free-pool entry mistral', exact: true }).click();
  await expect(fields.row('mistral')).toContainText('sibling-model');
  await fields.model.focus();
  await releaseEditableProbeRpc(page, poolProbeRpc, 1);
  await expect(fields.row('groq').locator('[data-recued-ai-models-slot-test-result="pool:groq"]')).toHaveAttribute('data-probe-ok', 'true');
  await expect(fields.model).toHaveValue('new-model');
  await expect(fields.model).toBeFocused();
});

test('Settings AI Models Free-pool stored-row probe cannot reappear after removing and reusing its name', async ({ page }) => {
  const fields = await openFreePoolProbeSettings(page, 'add', 'ai_source_probe=success');
  await fields.row('groq').getByRole('button', { name: 'Test the free-pool entry groq connection', exact: true }).click();
  await fields.row('groq').getByRole('button', { name: 'Remove free-pool entry groq', exact: true }).click();
  const dialog = page.locator('[data-recued-ai-models-pool-remove-dialog="groq"]');
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.locator('[data-recued-ai-models-pool-remove-confirm="groq"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(fields.row('groq')).toHaveCount(0);
  await fields.field('id').fill('groq');
  await fields.model.fill('readded-model');
  await fields.submit.click();
  await expect(fields.row('groq')).toContainText('readded-model');
  await releaseEditableProbeRpc(page, poolProbeRpc, 1);
  await expect(fields.row('groq').locator('[data-recued-ai-models-slot-test-result="pool:groq"]')).toHaveCount(0);
});

test('Settings AI Models Free-pool probe follows a changed automatic name after removal', async ({ page }) => {
  const fields = await openFreePoolProbeSettings(page, 'add', 'ai_source_probe=success');
  await fields.field('id').fill('');
  await fields.field('base-url').fill('https://api.groq.com/openai/v1');
  await fields.test.click();
  await fields.row('groq').getByRole('button', { name: 'Remove free-pool entry groq', exact: true }).click();
  const dialog = page.locator('[data-recued-ai-models-pool-remove-dialog="groq"]');
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.locator('[data-recued-ai-models-pool-remove-confirm="groq"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(fields.row('groq')).toHaveCount(0);
  await releaseEditableProbeRpc(page, poolProbeRpc, 1);
  await expect(fields.probe).toHaveCount(0);
  await fields.test.click();
  await releaseEditableProbeRpc(page, poolProbeRpc, 2);
  await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
  await fields.submit.click();
  await expect(fields.row('groq')).toContainText('new-model');
});

const transcriptionWrites = [
  'server.setTranscriptionSlot',
  'server.setTranscriptionLanguage',
  'server.setTranscriptionDailyRequests',
] as const;
const heldTranscriptionWrites = transcriptionWrites.map((method) => `hold_rpc=${method}`).join('&');

const openTranscriptionSettings = async (page: Page, query: string) => {
  await page.goto(`${HARNESS_URL}?ai=two&${query}#settings/ai-models`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const providers = page.locator(`[${AI_MODELS_TAB}="providers"]`);
  await expect(providers).toBeVisible();
  await providers.focus();
  await page.keyboard.press('Enter');
  const card = page.locator('[data-recued-ai-models-control="transcription_slot"]');
  await expect(card).toBeVisible();
  return {
    card,
    protocol: card.getByRole('combobox', { name: 'Transcription slot protocol' }),
    model: card.getByRole('textbox', { name: 'Transcription slot model' }),
    key: card.locator('[data-recued-ai-models-transcription-field="api-key"]'),
    language: card.getByRole('textbox', { name: 'Transcription spoken language' }),
    limit: card.getByRole('textbox', { name: 'Transcription daily call limit' }),
    save: card.getByRole('button', { name: 'Save Transcription slot', exact: true }),
    clear: card.getByRole('button', { name: 'Clear Transcription slot', exact: true }),
    test: card.getByRole('button', { name: 'Test the Transcription slot connection', exact: true }),
    probe: card.locator('[data-recued-ai-models-slot-test-result="transcription_slot"]'),
    transcript: card.locator('[data-recued-ai-models-probe-transcript]'),
    testError: card.locator('[data-recued-ai-models-form-error="transcription_slot:test"]'),
  };
};

const fillTranscriptionDraft = async (fields: Awaited<ReturnType<typeof openTranscriptionSettings>>) => {
  await fields.protocol.selectOption('openai');
  await fields.model.fill('whisper-draft');
  await fields.key.fill('transcription-fixture-key');
  await fields.language.fill(' fr ');
  await fields.limit.fill('12');
};

const releaseTranscriptionWrite = async (page: Page, method: string, count: number) => {
  await expect.poll(() => page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(count);
  expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, method)).toBe(1);
};

const auditAiModelsExitConfirm = async (page: Page) => {
  await page.evaluate(() => {
    const html = document.documentElement;
    html.setAttribute('data-audit-ai-exit-count', '0');
    html.setAttribute('data-audit-ai-exit-allowed', 'false');
    window.confirm = (message?: string): boolean => {
      html.setAttribute('data-audit-ai-exit-count', String(Number(html.getAttribute('data-audit-ai-exit-count')) + 1));
      html.setAttribute('data-audit-ai-exit-message', message ?? '');
      return html.getAttribute('data-audit-ai-exit-allowed') === 'true';
    };
  });
};

const aiModelsUnloadAllowed = (page: Page) => page.evaluate(() =>
  window.dispatchEvent(new Event('beforeunload', { cancelable: true })),
);

const cancelPendingAiModelsLeave = async (page: Page, count: number) => {
  expect(await aiModelsUnloadAllowed(page)).toBe(false);
  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#settings\/ai-models$/);
  await expect(page.locator('html')).toHaveAttribute('data-audit-ai-exit-count', String(count));
  await expect(page.locator('html')).toHaveAttribute(
    'data-audit-ai-exit-message',
    'An AI model setting is still updating. Leave Settings anyway?',
  );
};

const leaveSettledAiModels = async (page: Page, count: number) => {
  expect(await aiModelsUnloadAllowed(page)).toBe(true);
  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(page.locator('html')).toHaveAttribute('data-audit-ai-exit-count', String(count));
};

for (const size of [
  { name: 'desktop', viewport: { width: 1360, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  test(`Settings AI Models exit guard ${size.name} transcription success`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const fields = await openTranscriptionSettings(page, heldTranscriptionWrites);
    await auditAiModelsExitConfirm(page);
    await fillTranscriptionDraft(fields);
    await fields.save.focus();
    await page.keyboard.press('Enter');

    for (const [index, method] of transcriptionWrites.entries()) {
      await expect(fields.save).toHaveAttribute('aria-busy', 'true');
      await cancelPendingAiModelsLeave(page, index + 1);
      await expect(fields.save).toBeFocused();
      await expect(fields.model).toHaveValue('whisper-draft');
      await releaseTranscriptionWrite(page, method, 1);
    }
    await expect(fields.save).not.toHaveAttribute('aria-busy');
    await expect(fields.language).toHaveValue('fr');
    await expect(fields.limit).toHaveValue('12');
    for (const method of transcriptionWrites) {
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(1);
    }
    await leaveSettledAiModels(page, transcriptionWrites.length);
  });

  for (const [failedIndex, phase] of ['slot', 'language', 'limit'].entries()) {
    test(`Settings AI Models exit guard ${size.name} transcription ${phase} failure`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      const fields = await openTranscriptionSettings(
        page, `ai_transcription=configured&ai_transcription_fail_first=${phase}&${heldTranscriptionWrites}`,
      );
      await auditAiModelsExitConfirm(page);
      await fillTranscriptionDraft(fields);
      await fields.save.focus();
      await page.keyboard.press('Enter');
      for (const [index, method] of transcriptionWrites.slice(0, failedIndex + 1).entries()) {
        await expect(fields.save).toHaveAttribute('aria-busy', 'true');
        await cancelPendingAiModelsLeave(page, index + 1);
        await expect(fields.save).toBeFocused();
        await releaseTranscriptionWrite(page, method, 1);
      }
      await expect(fields.card.locator('[data-recued-ai-models-form-error="transcription_slot:save"]'))
        .toContainText('unavailable.');
      await expect(fields.save).not.toHaveAttribute('aria-busy');
      for (const method of transcriptionWrites.slice(failedIndex + 1)) {
        expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(0);
      }
      await leaveSettledAiModels(page, failedIndex + 1);
    });
  }

  for (const chatSwitch of chatBehaviourSwitchCases) {
    for (const outcome of ['success', 'failure'] as const) {
      test(`Settings AI Models exit guard ${size.name} ${chatSwitch.name} ${outcome}`, async ({ page }) => {
        await page.setViewportSize(size.viewport);
        const method = `${chatSwitch.rpc}.set`;
        await page.goto(`${HARNESS_URL}?ai=two&hold_rpc=${method}${outcome === 'failure' ? '&ai_chat_switch_response=fail-first' : ''}#settings/ai-models`);
        await page.waitForFunction(() => window.__app?.ready === true);
        await auditAiModelsExitConfirm(page);
        const toggle = page.locator(`[${chatSwitch.attr}]`);
        await expect(toggle).toHaveText(chatSwitch.onLabel);
        await toggle.focus();
        await page.keyboard.press('Enter');
        await expect(toggle).toHaveAttribute('aria-busy', 'true');
        await cancelPendingAiModelsLeave(page, 1);
        await expect(toggle).toBeFocused();
        expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, method)).toBe(1);
        await expect(toggle).not.toHaveAttribute('aria-busy');
        await expect(toggle).toHaveAttribute('aria-pressed', outcome === 'success' ? 'false' : 'true');
        if (outcome === 'failure') {
          await expect(page.locator('[data-recued-ai-models-action-error]'))
            .toHaveText('Chat behaviour update unavailable.');
        }
        expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(1);
        await leaveSettledAiModels(page, 1);
      });
    }
  }

  test(`Settings AI Models exit guard ${size.name} overlapping chat switches`, async ({ page }) => {
    await page.setViewportSize(size.viewport);
    const methods = chatBehaviourSwitchCases.map((chatSwitch) => `${chatSwitch.rpc}.set`);
    await page.goto(`${HARNESS_URL}?ai=two&${methods.map((rpc) => `hold_rpc=${rpc}`).join('&')}#settings/ai-models`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await auditAiModelsExitConfirm(page);
    const toggles = chatBehaviourSwitchCases.map((chatSwitch) => page.locator(`[${chatSwitch.attr}]`));
    for (const toggle of toggles) {
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-busy', 'true');
    }
    await cancelPendingAiModelsLeave(page, 1);
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, methods[0]!)).toBe(1);
    await expect(toggles[0]!).not.toHaveAttribute('aria-busy');
    await expect(toggles[1]!).toHaveAttribute('aria-busy', 'true');
    await expect(toggles[1]!).toBeFocused();
    await cancelPendingAiModelsLeave(page, 2);
    expect(await page.evaluate((rpc) => window.__app.releaseRpcResponses?.(rpc) ?? 0, methods[1]!)).toBe(1);
    await expect(toggles[1]!).not.toHaveAttribute('aria-busy');
    for (const method of methods) {
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(1);
    }
    await leaveSettledAiModels(page, 2);
  });

  for (const action of ['transcription', ...chatBehaviourSwitchCases.map((chatSwitch) => chatSwitch.name)]) {
    test(`Settings AI Models exit guard ${size.name} permits confirmed leave during ${action}`, async ({ page }) => {
      await page.setViewportSize(size.viewport);
      let methods: readonly string[];
      if (action === 'transcription') {
        const fields = await openTranscriptionSettings(page, heldTranscriptionWrites);
        await auditAiModelsExitConfirm(page);
        await fillTranscriptionDraft(fields);
        await fields.save.focus();
        await page.keyboard.press('Enter');
        await expect(fields.save).toHaveAttribute('aria-busy', 'true');
        methods = transcriptionWrites;
      } else {
        const chatSwitch = chatBehaviourSwitchCases.find((candidate) => candidate.name === action)!;
        methods = [`${chatSwitch.rpc}.set`];
        await page.goto(`${HARNESS_URL}?ai=two&hold_rpc=${methods[0]}#settings/ai-models`);
        await page.waitForFunction(() => window.__app?.ready === true);
        await auditAiModelsExitConfirm(page);
        const toggle = page.locator(`[${chatSwitch.attr}]`);
        await toggle.focus();
        await page.keyboard.press('Enter');
        await expect(toggle).toHaveAttribute('aria-busy', 'true');
      }
      expect(await aiModelsUnloadAllowed(page)).toBe(false);
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-audit-ai-exit-allowed', 'true');
        window.__app.setHash('#data');
      });
      await expect(page).toHaveURL(/#data$/);
      await expect(page.locator('html')).toHaveAttribute('data-audit-ai-exit-count', '1');
      for (const method of methods) await releaseTranscriptionWrite(page, method, 1);
      await expect(page).toHaveURL(/#data$/);
      await expect(page.locator('[data-recued-ai-models-page-state]')).toHaveCount(0);
      expect(await aiModelsUnloadAllowed(page)).toBe(true);
    });
  }
}

for (const { field, value } of [
  { field: 'model', value: 'whisper-edit' },
  { field: 'language', value: 'fr' },
  { field: 'daily-requests', value: '125' },
  { field: 'provider', value: 'openai-compatible' },
]) {
  test(`Settings AI Models transcription ${field} keeps focus when a sibling save completes`, async ({ page }) => {
    const { card } = await openTranscriptionSettings(
      page,
      'ai_pool=entry&ai_transcription=configured&hold_rpc=server.setFreePoolEntryEnabled',
    );
    const toggle = page.locator('[data-recued-ai-models-pool-toggle="groq"]');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveText('Disabling…');

    const input = card.locator(`[data-recued-ai-models-transcription-field="${field}"]`);
    if (field === 'provider') {
      await input.selectOption(value);
      await input.focus();
    } else {
      await input.fill(value);
      await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 1));
    }
    await releaseTranscriptionWrite(page, 'server.setFreePoolEntryEnabled', 1);
    await expect(toggle).toHaveText('Enable');
    await expect(input).toHaveValue(value);
    await expect(input).toBeFocused();
    if (field !== 'provider') {
      expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]))
        .toEqual([1, 1]);
      await page.keyboard.type('x');
      await expect(input).toHaveValue(`${value.slice(0, 1)}x${value.slice(1)}`);
    }
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.setTranscriptionSlot'))).toBe(0);
  });
}

test('Settings AI Models transcription Save owns all three writes and preserves sibling drafts', async ({ page }) => {
  const fields = await openTranscriptionSettings(page, heldTranscriptionWrites);
  await fillTranscriptionDraft(fields);
  const siblingDraft = page.locator('[data-recued-ai-models-control="slot_2"]')
    .getByRole('textbox', { name: 'Slot 2: better, slower thinking model', exact: true });
  await siblingDraft.fill('unsaved-chat-model');
  await fields.save.focus();
  await page.keyboard.press('Enter');

  for (const method of transcriptionWrites) {
    await expect.poll(() => page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(1);
    await expect(fields.save).toHaveText('Saving slot…');
    await expect(fields.save).toHaveAttribute('aria-disabled', 'true');
    await expect(fields.save).toHaveAttribute('aria-busy', 'true');
    await expect(fields.save).not.toHaveAttribute('disabled');
    await expect(fields.save).toBeFocused();
    await expect(fields.protocol).toBeDisabled();
    await expect(fields.model).toHaveAttribute('readonly', '');
    await expect(fields.language).toHaveAttribute('readonly', '');
    await expect(fields.limit).toHaveAttribute('readonly', '');
    await expect(siblingDraft).toHaveValue('unsaved-chat-model');
    await page.keyboard.press('Enter');
    await fields.clear.evaluate((button: HTMLElement) => button.click());
    await expect(page.locator(`[${AI_MODELS_SLOT_CLEAR_DIALOG}]`)).toHaveCount(0);
    await releaseTranscriptionWrite(page, method, 1);
  }

  await expect(fields.save).toHaveText('Save slot');
  await expect(fields.save).not.toHaveAttribute('aria-busy');
  await expect(fields.save).not.toHaveAttribute('aria-disabled');
  await expect(fields.save).toBeFocused();
  await expect(fields.protocol).toBeEnabled();
  await expect(fields.model).toHaveValue('whisper-draft');
  await expect(fields.key).toHaveValue('');
  await expect(fields.language).toHaveValue('fr');
  await expect(fields.limit).toHaveValue('12');
  await expect(siblingDraft).toHaveValue('unsaved-chat-model');
  for (const method of transcriptionWrites) {
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(1);
  }

  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page.locator('[data-recued-chat-route]')).toHaveCount(1);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();
  await expect(fields.card).toBeVisible();
  await expect(fields.model).toHaveValue('whisper-draft');
  await expect(fields.language).toHaveValue('fr');
  await expect(fields.limit).toHaveValue('12');
  await expect(fields.key).toHaveValue('');
});

for (const [failedIndex, failure] of [
  { phase: 'slot', message: 'Transcription slot save unavailable.' },
  { phase: 'language', message: 'Transcription language save unavailable.' },
  { phase: 'limit', message: 'Transcription daily limit save unavailable.' },
].entries()) {
  test(`Settings AI Models transcription ${failure.phase} failure preserves the remaining retry draft`, async ({ page }) => {
    const fields = await openTranscriptionSettings(
      page,
      `ai_transcription=configured&ai_transcription_fail_first=${failure.phase}&${heldTranscriptionWrites}`,
    );
    await fillTranscriptionDraft(fields);
    await fields.save.focus();
    await page.keyboard.press('Enter');
    for (const method of transcriptionWrites.slice(0, failedIndex + 1)) {
      await releaseTranscriptionWrite(page, method, 1);
    }

    const error = fields.card.locator('[data-recued-ai-models-form-error="transcription_slot:save"]');
    await expect(error).toHaveText(failure.message);
    await expect(page.locator('[data-recued-ai-models-action-error]')).toHaveCount(0);
    await expect(fields.save).toHaveText('Save slot');
    await expect(fields.save).toBeFocused();
    await expect(fields.model).toHaveValue('whisper-draft');
    await expect(fields.key).toHaveValue(failedIndex === 0 ? 'transcription-fixture-key' : '');
    await expect(fields.language).toHaveValue(failedIndex === 2 ? 'fr' : ' fr ');
    await expect(fields.limit).toHaveValue('12');
    await expect(fields.language).not.toHaveAttribute('readonly');
    await expect(fields.limit).not.toHaveAttribute('readonly');
    for (const method of transcriptionWrites.slice(failedIndex + 1)) {
      expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(0);
    }

    await page.keyboard.press('Space');
    await expect(error).toHaveCount(0);
    await releaseTranscriptionWrite(page, transcriptionWrites[0], 2);
    if (failedIndex < 2) {
      await releaseTranscriptionWrite(page, transcriptionWrites[1], failedIndex === 1 ? 2 : 1);
    }
    await releaseTranscriptionWrite(page, transcriptionWrites[2], failedIndex === 2 ? 2 : 1);
    await expect(fields.save).toHaveText('Save slot');
    await expect(fields.save).toBeFocused();
    await expect(fields.model).toHaveValue('whisper-draft');
    await expect(fields.language).toHaveValue('fr');
    await expect(fields.limit).toHaveValue('12');
    await expect(fields.key).toHaveValue('');
    await expect(error).toHaveCount(0);
  });
}

test('Settings AI Models transcription Clear confirms only the slot and retains language drafts', async ({ page }) => {
  const fields = await openTranscriptionSettings(
    page,
    'ai_transcription=configured&hold_rpc=server.setTranscriptionSlot',
  );
  await fields.model.fill('unsaved-transcription-model');
  await fields.language.fill('fr');
  await fields.limit.fill('12');
  await fields.clear.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator(`[${AI_MODELS_SLOT_CLEAR_DIALOG}="transcription_slot"]`);
  const cancel = dialog.locator(`[${AI_MODELS_SLOT_CLEAR_CANCEL}="transcription_slot"]`);
  const confirm = dialog.locator(`[${AI_MODELS_SLOT_CLEAR_CONFIRM}="transcription_slot"]`);
  await expect(dialog).toHaveAccessibleName('Clear Transcription slot?');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(fields.clear).toBeFocused();
  await expect(fields.model).toHaveValue('unsaved-transcription-model');
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.setTranscriptionSlot'))).toBe(0);

  await page.keyboard.press('Enter');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await releaseTranscriptionWrite(page, transcriptionWrites[0], 1);
  await expect(dialog).toHaveCount(0);
  await expect(fields.clear).toBeFocused();
  await expect(fields.model).toHaveValue('');
  await expect(fields.card).toContainText('Not set up. Voice notes need this.');
  await expect(fields.language).toHaveValue('fr');
  await expect(fields.limit).toHaveValue('12');
  for (const method of transcriptionWrites.slice(1)) {
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(0);
  }
});

test('Settings AI Models transcription failed Clear remains owned and retryable', async ({ page }) => {
  const fields = await openTranscriptionSettings(
    page,
    'ai_transcription=configured&ai_transcription_fail_first=clear&hold_rpc=server.setTranscriptionSlot',
  );
  // Saving first must neither consume the injected Clear failure nor lose
  // the existing key when the form leaves its password field blank.
  await fields.save.focus();
  await page.keyboard.press('Enter');
  await releaseTranscriptionWrite(page, transcriptionWrites[0], 1);
  await expect(fields.save).toHaveText('Save slot');
  await expect(fields.model).toHaveValue('whisper-1');
  await expect(fields.key).toHaveValue('');
  await fields.clear.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator(`[${AI_MODELS_SLOT_CLEAR_DIALOG}="transcription_slot"]`);
  const confirm = dialog.locator(`[${AI_MODELS_SLOT_CLEAR_CONFIRM}="transcription_slot"]`);
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await releaseTranscriptionWrite(page, transcriptionWrites[0], 2);
  await expect(page.locator('[data-recued-ai-models-action-error]'))
    .toHaveText('Transcription slot clear unavailable.');
  await expect(dialog).toBeVisible();
  await expect(confirm).toBeFocused();
  await expect(fields.model).toHaveValue('whisper-1');
  await expect(confirm).not.toHaveAttribute('aria-disabled');
  await page.keyboard.press('Enter');
  await releaseTranscriptionWrite(page, transcriptionWrites[0], 3);
  await expect(dialog).toHaveCount(0);
  await expect(fields.clear).toBeFocused();
  await expect(fields.model).toHaveValue('');
});

const heldTranscriptionProbe = 'ai_transcription=configured&hold_rpc=server.probeLlmSource';
const probeMethod = 'server.probeLlmSource';

test('Settings AI Models transcription probe shows the heard and expected text and owns keyboard focus', async ({ page }) => {
  const fields = await openTranscriptionSettings(page, `${heldTranscriptionProbe}&ai_transcription_probe=mismatch`);
  await fields.model.fill('whisper-unsaved');
  await fields.key.fill('probe-fixture-key');
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(0);
  await fields.test.focus();
  await page.keyboard.press('Enter');
  await expect(fields.test).toHaveText('Testing…');
  await expect(fields.test).toHaveAttribute('aria-busy', 'true');
  await expect(fields.test).toHaveAttribute('aria-disabled', 'true');
  await expect(fields.test).not.toHaveAttribute('disabled');
  await expect(fields.test).toBeFocused();
  await expect(fields.probe).toHaveCount(0);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  const siblingTest = page.locator('[data-recued-ai-models-slot-test="slot_1"]');
  await expect(siblingTest).toHaveAttribute('aria-disabled', 'true');
  await siblingTest.evaluate((button: HTMLElement) => button.click());
  await releaseTranscriptionWrite(page, probeMethod, 1);

  await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
  await expect(fields.probe).toHaveAttribute('role', 'status');
  expect(await fields.transcript.locator('dt').allTextContents()).toEqual(['Clip says', 'Heard', 'Language']);
  expect(await fields.transcript.locator('dd').allTextContents()).toEqual([
    'This is a transcript microphone test.',
    'Bu bir transkript mikrofon testidir.',
    'tr',
  ]);
  await expect(fields.probe.locator('[data-recued-ai-models-probe-pictures]')).toHaveCount(0);
  await expect(fields.test).toHaveText('Test connection');
  await expect(fields.test).not.toHaveAttribute('aria-busy');
  await expect(siblingTest).not.toHaveAttribute('aria-disabled');
  await expect(fields.test).toBeFocused();
  await expect(fields.model).toHaveValue('whisper-unsaved');
  await expect(fields.key).toHaveValue('probe-fixture-key');
  for (const method of transcriptionWrites) {
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), method)).toBe(0);
  }
});

test('Settings AI Models transcription probe labels auto-detection explicitly', async ({ page }) => {
  const fields = await openTranscriptionSettings(page, `${heldTranscriptionProbe}&ai_transcription_probe=auto`);
  await expect(fields.language).toHaveValue('');
  await fields.test.focus();
  await page.keyboard.press('Space');
  await releaseTranscriptionWrite(page, probeMethod, 1);
  await expect(fields.transcript).toContainText('auto-detect');
  await expect(fields.transcript).toContainText('This is a transcript microphone test.');
  await expect(fields.test).toBeFocused();
});

for (const mode of ['rejected-first', 'rpc-fail-first']) {
  test(`Settings AI Models transcription probe ${mode} is explained locally and retryable`, async ({ page }) => {
    const fields = await openTranscriptionSettings(page, `${heldTranscriptionProbe}&ai_transcription_probe=${mode}`);
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await releaseTranscriptionWrite(page, probeMethod, 1);
    if (mode === 'rejected-first') {
      await expect(fields.probe).toHaveAttribute('data-probe-ok', 'false');
      await expect(fields.probe).toContainText('That key was refused. Check it.');
      await expect(fields.probe).toContainText('The fixture transcription endpoint refused the key.');
      await expect(fields.probe.locator('.ai-models-probe-facts')).toHaveCount(0);
      await expect(fields.testError).toHaveCount(0);
    } else {
      await expect(fields.testError).toHaveText('Transcription probe transport unavailable.');
      await expect(fields.testError).toHaveAttribute('role', 'alert');
      await expect(fields.probe).toHaveCount(0);
    }
    await expect(fields.transcript).toHaveCount(0);
    await expect(page.locator('[data-recued-ai-models-action-error]')).toHaveCount(0);
    await expect(fields.test).not.toHaveAttribute('aria-busy');
    await expect(fields.test).toBeFocused();
    await page.keyboard.press('Space');
    await expect(fields.probe).toHaveCount(0);
    await expect(fields.testError).toHaveCount(0);
    await releaseTranscriptionWrite(page, probeMethod, 2);
    await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
    await expect(fields.transcript).toBeVisible();
    await expect(fields.test).toBeFocused();
  });
}

test('Settings AI Models transcription probe with no sample reports that nothing was tested', async ({ page }) => {
  const fields = await openTranscriptionSettings(page, `${heldTranscriptionProbe}&ai_transcription_probe=no-sample`);
  await fields.test.focus();
  await page.keyboard.press('Enter');
  await releaseTranscriptionWrite(page, probeMethod, 1);
  await expect(fields.probe).toHaveAttribute('data-probe-ok', 'false');
  await expect(fields.probe).toContainText('The transcription test clip is unavailable in this fixture.');
  await expect(fields.probe.locator('.ai-models-probe-facts')).toHaveCount(0);
  await expect(fields.transcript).toHaveCount(0);
  await expect(fields.test).toBeFocused();
});

for (const mode of ['draft', 'rejected-first', 'rpc-fail-first']) {
  test(`Settings AI Models transcription probe ignores a stale ${mode} reply after a draft edit`, async ({ page }) => {
    const fields = await openTranscriptionSettings(page, `${heldTranscriptionProbe}&ai_transcription_probe=${mode}`);
    await fields.model.fill('whisper-first');
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await expect(fields.test).toHaveText('Testing…');
    await fields.model.fill('whisper-second');
    await fields.model.evaluate((element: HTMLInputElement) => element.setSelectionRange(5, 5));
    await releaseTranscriptionWrite(page, probeMethod, 1);
    await expect(fields.test).toHaveText('Test connection');
    await expect(fields.probe).toHaveCount(0);
    await expect(fields.testError).toHaveCount(0);
    await expect(fields.model).toHaveValue('whisper-second');
    await expect(fields.model).toBeFocused();
    expect(await fields.model.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]))
      .toEqual([5, 5]);
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);

    await fields.test.focus();
    await page.keyboard.press('Enter');
    await releaseTranscriptionWrite(page, probeMethod, 2);
    await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
    await expect(fields.transcript).toContainText(mode === 'draft'
      ? 'Fixture transcript from whisper-second.'
      : 'This is a transcript microphone test.');
  });
}

for (const mode of ['draft', 'rpc-fail-first']) {
  test(`Settings AI Models transcription probe removes a completed ${mode} answer when its draft changes`, async ({ page }) => {
    const fields = await openTranscriptionSettings(page, `${heldTranscriptionProbe}&ai_transcription_probe=${mode}`);
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await releaseTranscriptionWrite(page, probeMethod, 1);
    if (mode === 'draft') await expect(fields.probe).toBeVisible();
    else await expect(fields.testError).toBeVisible();
    const originalInput = await fields.model.elementHandle();
    await fields.model.fill('whisper-new-draft');
    await expect(fields.probe).toHaveCount(0);
    await expect(fields.testError).toHaveCount(0);
    await expect(fields.model).toBeFocused();
    expect(await originalInput!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
    await page.keyboard.type('-continued');
    await expect(fields.model).toHaveValue('whisper-new-draft-continued');
  });
}

test('Settings AI Models transcription probe preserves unsaved language and limit edits', async ({ page }) => {
  const fields = await openTranscriptionSettings(page, `${heldTranscriptionProbe}&ai_transcription_probe=draft`);
  await fields.test.focus();
  await page.keyboard.press('Enter');
  await fields.language.fill('fr');
  await fields.limit.fill('22');
  await fields.limit.evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 1));
  await releaseTranscriptionWrite(page, probeMethod, 1);
  await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
  expect(await fields.transcript.locator('dd').allTextContents()).toEqual([
    'This is a transcript microphone test.',
    'Fixture transcript from whisper-1.',
    'en',
  ]);
  await expect(fields.language).toHaveValue('fr');
  await expect(fields.limit).toHaveValue('22');
  await expect(fields.limit).toBeFocused();
  expect(await fields.limit.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]))
    .toEqual([1, 1]);
});

test('Settings AI Models transcription probe cannot restore an answer after Clear', async ({ page }) => {
  const fields = await openTranscriptionSettings(
    page,
    `${heldTranscriptionProbe}&ai_transcription_probe=draft&hold_rpc=server.setTranscriptionSlot`,
  );
  await fields.test.focus();
  await page.keyboard.press('Enter');
  await expect(fields.test).toHaveText('Testing…');
  await fields.clear.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator(`[${AI_MODELS_SLOT_CLEAR_DIALOG}="transcription_slot"]`);
  const confirm = dialog.locator(`[${AI_MODELS_SLOT_CLEAR_CONFIRM}="transcription_slot"]`);
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await releaseTranscriptionWrite(page, transcriptionWrites[0], 1);
  await expect(dialog).toHaveCount(0);
  await expect(fields.model).toHaveValue('');
  await releaseTranscriptionWrite(page, probeMethod, 1);
  await expect(fields.probe).toHaveCount(0);
  await expect(fields.clear).toBeFocused();
});

test('Settings AI Models transcription probe cannot restore an answer after saving the language', async ({ page }) => {
  const fields = await openTranscriptionSettings(page, `${heldTranscriptionProbe}&ai_transcription_probe=draft`);
  await fields.test.focus();
  await page.keyboard.press('Enter');
  await expect(fields.test).toHaveText('Testing…');
  await fields.language.fill('fr');
  await fields.save.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('server.setTranscriptionLanguage'))).toBe(1);
  await expect(fields.save).toHaveText('Save slot');
  await releaseTranscriptionWrite(page, probeMethod, 1);
  await expect(fields.probe).toHaveCount(0);
  await expect(fields.save).toBeFocused();
  await fields.test.focus();
  await page.keyboard.press('Enter');
  await releaseTranscriptionWrite(page, probeMethod, 2);
  await expect(fields.transcript).toContainText('fr');
});

const aiRefreshSources = ['BYOK', 'Embeddings', 'Transcription', 'pool row', 'pool add', 'pool edit'] as const;
const openAiRefreshSource = async (page: Page, source: typeof aiRefreshSources[number], outcome = 'success') => {
  const query = `hold_rpc=server.probeLlmSource&ai_source_probe=${outcome}`;
  if (source === 'BYOK' || source === 'Embeddings') {
    return openEditableProbeSettings(page, editableProbeSources[source === 'BYOK' ? 0 : 1], query);
  }
  if (source === 'Transcription') {
    await page.setViewportSize({ width: 390, height: 844 });
    return openTranscriptionSettings(page, `${query}&ai_transcription=configured&ai_transcription_probe=${outcome}`);
  }
  const fields = await openFreePoolProbeSettings(page, source === 'pool edit' ? 'edit' : 'add', query);
  if (source === 'pool row') {
    const card = fields.row('groq');
    return {
      ...fields, card,
      test: card.locator('[data-recued-ai-models-slot-test="pool:groq"]'),
      probe: card.locator('[data-recued-ai-models-slot-test-result="pool:groq"]'),
      testError: card.locator('[data-recued-ai-models-form-error="pool:groq:test"]'),
    };
  }
  return { ...fields, card: fields.form, testError: fields.error };
};
const startAiModelsRefresh = async (page: Page, config?: Record<string, unknown>, fail = false) => {
  const before = await page.evaluate(() => window.__app.rpcCallCount('server.getLLMConfig'));
  await page.evaluate(({ config, fail }) => {
    if (config !== undefined) window.__app.setAiModelsConfig?.(config);
    if (fail) window.__app.failNextAiModelsConfigRead?.();
    window.__app.holdRpcResponses?.('server.getLLMConfig');
    void window.__app.refreshAiModels?.();
  }, { config, fail });
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('server.getLLMConfig'))).toBe(before + 1);
};
const releaseAiModelsRefresh = async (page: Page, index = 0) => {
  expect(await page.evaluate((index) => window.__app.releaseRpcResponses?.('server.getLLMConfig', index) ?? 0, index)).toBe(1);
};
const aiRefreshConfig = (model: string) => ({ slot_1: { provider: 'openai', model, has_key: true } });
const aiRefreshState = (page: Page) => page.locator('[data-recued-ai-models-page-state]');

for (const source of aiRefreshSources) {
  test(`Settings AI Models saved-config refresh clears ${source} answers and preserves typing and caret`, async ({ page }) => {
    const fields = await openAiRefreshSource(page, source);
    await fields.model.fill('refresh-draft-model');
    await fields.key.fill('refresh-fixture-key');
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await releaseEditableProbeRpc(page, probeMethod, 1);
    await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
    await fields.model.focus();
    await fields.model.evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 6));
    await startAiModelsRefresh(page);
    await expect(fields.probe).toHaveCount(0);
    await expect(fields.testError).toHaveCount(0);
    await expect(fields.model).toHaveValue('refresh-draft-model');
    await expect(fields.key).toHaveValue('refresh-fixture-key');
    await expect(fields.model).toBeFocused();
    expect(await fields.model.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([2, 6]);
    await fields.test.focus();
    await expect(fields.test).toHaveAttribute('aria-disabled', 'true');
    await expect(fields.test).not.toHaveAttribute('disabled');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
    await fields.model.focus();
    await fields.model.evaluate((el: HTMLInputElement) => el.setSelectionRange(2, 2));
    await page.keyboard.type('X');
    await expect(fields.model).toHaveValue('reXfresh-draft-model');
    await releaseAiModelsRefresh(page);
    await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
    await expect(fields.model).toBeFocused();
    expect(await fields.model.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([3, 3]);
    await expect(fields.test).not.toHaveAttribute('aria-disabled');
    await expect(fields.probe).toHaveCount(0);
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await releaseEditableProbeRpc(page, probeMethod, 2);
    await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.setLLMSlot'))).toBe(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.upsertFreePoolEntry'))).toBe(0);
  });

  const outcome = source === 'BYOK' || source === 'pool add' ? 'rpc-fail-first'
    : source === 'Embeddings' || source === 'pool edit' ? 'rejected-first' : 'success';
  test(`Settings AI Models saved-config refresh ignores pending ${source} ${outcome} and keeps probes single-flight`, async ({ page }) => {
    const fields = await openAiRefreshSource(page, source, outcome);
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await expect(fields.test).toHaveText('Testing…');
    await startAiModelsRefresh(page);
    await releaseAiModelsRefresh(page);
    await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
    await expect(fields.test).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
    await releaseEditableProbeRpc(page, probeMethod, 1);
    await expect(fields.test).not.toHaveAttribute('aria-busy');
    await expect(fields.probe).toHaveCount(0);
    await expect(fields.testError).toHaveCount(0);
    await expect(fields.test).toBeFocused();
    await page.keyboard.press('Enter');
    await releaseEditableProbeRpc(page, probeMethod, 2);
    await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
  });
}

for (const outcome of ['success', 'failure'] as const) {
  test(`Settings AI Models saved-config refresh ignores an older ${outcome} after a newer read`, async ({ page }) => {
    const fields = await openAiRefreshSource(page, 'BYOK');
    await startAiModelsRefresh(page, aiRefreshConfig('older-model'), outcome === 'failure');
    await startAiModelsRefresh(page, aiRefreshConfig('newest-model'));
    await releaseAiModelsRefresh(page, 1);
    await expect(fields.card).toContainText('OpenAI / newest-model');
    await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
    await fields.test.focus();
    await page.keyboard.press('Enter');
    await releaseEditableProbeRpc(page, probeMethod, 1);
    await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
    await releaseAiModelsRefresh(page);
    await expect(fields.card).toContainText('OpenAI / newest-model');
    await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
    await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
    await expect(fields.test).toBeFocused();
  });
}

test('Settings AI Models saved-config refresh keeps the newer read pending when an older read finishes', async ({ page }) => {
  const fields = await openAiRefreshSource(page, 'BYOK');
  await startAiModelsRefresh(page, aiRefreshConfig('older-model'));
  await startAiModelsRefresh(page, aiRefreshConfig('newest-model'));
  await releaseAiModelsRefresh(page);
  await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'loading');
  await fields.test.focus();
  await expect(fields.test).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(0);
  await releaseAiModelsRefresh(page);
  await expect(fields.card).toContainText('OpenAI / newest-model');
  await expect(fields.test).not.toHaveAttribute('aria-disabled');
  await expect(fields.test).toBeFocused();
});

for (const source of editableProbeSources) {
  test(`Settings AI Models saved-config refresh cannot overwrite a confirmed ${source.title} save`, async ({ page }) => {
    const fields = await openEditableProbeSettings(page, source, '');
    await fields.model.fill('confirmed-refresh-model');
    await fields.key.fill('confirmed-fixture-key');
    await startAiModelsRefresh(page);
    await fields.save.focus();
    await page.keyboard.press('Enter');
    await expect(fields.card).toContainText('OpenAI / confirmed-refresh-model');
    await expect(fields.save).not.toHaveAttribute('aria-busy');
    await releaseAiModelsRefresh(page);
    await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
    await expect(fields.card).toContainText('OpenAI / confirmed-refresh-model');
    await expect(fields.model).toHaveValue('confirmed-refresh-model');
    await expect(fields.save).toBeFocused();
    expect(await page.evaluate((rpc) => window.__app.rpcCallCount(rpc), source.write)).toBe(1);
  });
}

test('Settings AI Models saved-config refresh failure removes old answers and stays blocked until its read settles', async ({ page }) => {
  const fields = await openAiRefreshSource(page, 'BYOK');
  await fields.test.focus();
  await page.keyboard.press('Enter');
  await startAiModelsRefresh(page, undefined, true);
  await releaseEditableProbeRpc(page, probeMethod, 1);
  await expect(fields.test).not.toHaveAttribute('aria-busy');
  await expect(fields.test).toHaveAttribute('aria-disabled', 'true');
  await expect(fields.probe).toHaveCount(0);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
  await releaseAiModelsRefresh(page);
  await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'error');
  await expect(page.getByText('LLM config: Saved AI configuration unavailable.', { exact: true })).toBeVisible();
  await expect(fields.test).not.toHaveAttribute('aria-disabled');
  await expect(fields.test).toBeFocused();
  await startAiModelsRefresh(page);
  await releaseAiModelsRefresh(page);
  await expect(aiRefreshState(page)).toHaveAttribute('data-recued-ai-models-page-state', 'ready');
  await expect(fields.probe).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('server.probeLlmSource'))).toBe(1);
  await page.keyboard.press('Enter');
  await releaseEditableProbeRpc(page, probeMethod, 2);
  await expect(fields.probe).toHaveAttribute('data-probe-ok', 'true');
});

test('Settings AI Models embeddings draft survives sibling actions and saves', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai_pool=entry&ai_embeddings_save_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const embeddings = page.locator(
    '[data-recued-ai-models-control="embeddings_slot"]',
  );
  const provider = embeddings.getByRole('combobox', { name: 'Embeddings slot protocol' });
  const model = embeddings.getByRole('textbox', { name: 'Model' });
  const key = embeddings.locator(
    '[data-recued-ai-models-embeddings-field="api-key"]',
  );
  const baseUrl = embeddings.getByRole('textbox', { name: 'Base URL' });
  await provider.selectOption('openai-compatible');
  await model.fill('text-embedding-demo');
  await key.fill('embedding-secret');
  await baseUrl.fill('https://embeddings.example.test/v1');

  const poolToggle = page.locator(
    '[data-recued-ai-models-pool-toggle="groq"]',
  );
  await poolToggle.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__app.rpcCallCount('server.setFreePoolEntryEnabled') === 1,
  );
  await expect(provider).toHaveValue('openai-compatible');
  await expect(model).toHaveValue('text-embedding-demo');
  await expect(key).toHaveValue('embedding-secret');
  await expect(baseUrl).toHaveValue('https://embeddings.example.test/v1');

  const save = embeddings.locator(
    '[data-recued-ai-models-slot-save="embeddings_slot"]',
  );
  const clear = embeddings.locator(
    '[data-recued-ai-models-slot-clear="embeddings_slot"]',
  );
  await save.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__app.rpcCallCount('server.setEmbeddingsSlot') === 1,
  );
  await expect(save).toHaveText('Saving slot…');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  await expect(model).toHaveAttribute('readonly', '');
  await expect(clear).toHaveAttribute('aria-disabled', 'true');
  await expect(clear).not.toHaveAttribute('disabled');
  await save.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await clear.evaluate((button: HTMLElement) => button.click());
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setEmbeddingsSlot'),
  )).toBe(1);
  await expect(model).toHaveValue('text-embedding-demo');
  await expect(key).toHaveValue('embedding-secret');
  await expect(embeddings).toContainText(
    'OpenAI-compatible / text-embedding-demo',
  );
  await expect(key).toHaveValue('');
  await expect(save).toHaveText('Save slot');
  await expect(save).not.toHaveAttribute('aria-disabled');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).toBeFocused();
});

test('Settings AI Models embeddings save failures preserve the exact retry draft', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai_embeddings_save_response=fail-slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const embeddings = page.locator(
    '[data-recued-ai-models-control="embeddings_slot"]',
  );
  const model = embeddings.getByRole('textbox', { name: 'Model' });
  const key = embeddings.locator(
    '[data-recued-ai-models-embeddings-field="api-key"]',
  );
  await embeddings.getByRole('combobox', { name: 'Embeddings slot protocol' })
    .selectOption('openai');
  await model.fill('retry-embedding-model');
  await key.fill('retry-embedding-secret');
  const save = embeddings.locator(
    '[data-recued-ai-models-slot-save="embeddings_slot"]',
  );
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(save).toHaveText('Saving slot…');
  await expect(save).toBeFocused();

  // Under the card's buttons, as on a chat slot, and not the page banner.
  await expect(embeddings.locator('[data-recued-ai-models-form-error="embeddings_slot:save"]'))
    .toHaveText('Embeddings slot save unavailable.');
  await expect(page.locator('[data-recued-ai-models-action-error]')).toHaveCount(0);
  await expect(model).toHaveValue('retry-embedding-model');
  await expect(key).toHaveValue('retry-embedding-secret');
  await expect(model).not.toHaveAttribute('readonly');
  await expect(save).toHaveText('Save slot');
  await expect(save).not.toHaveAttribute('aria-disabled');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setEmbeddingsSlot'),
  )).toBe(1);
});

test('Settings AI Models embeddings Clear is confirmed and mutation-owned', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai_embeddings_clear_response=slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const embeddings = page.locator(
    '[data-recued-ai-models-control="embeddings_slot"]',
  );
  await embeddings.getByRole('combobox', { name: 'Embeddings slot protocol' })
    .selectOption('openai');
  await embeddings.getByRole('textbox', { name: 'Model' })
    .fill('text-embedding-3-small');
  await embeddings.locator(
    '[data-recued-ai-models-embeddings-field="api-key"]',
  ).fill('embedding-key');
  await embeddings.locator(
    '[data-recued-ai-models-slot-save="embeddings_slot"]',
  ).click();
  await page.waitForFunction(
    () => window.__app.rpcCallCount('server.setEmbeddingsSlot') === 1,
  );
  await expect(embeddings).toContainText('OpenAI / text-embedding-3-small');

  const clear = embeddings.locator(
    '[data-recued-ai-models-slot-clear="embeddings_slot"]',
  );
  await clear.focus();
  await page.keyboard.press('Enter');
  let dialog = page.locator(
    `[${AI_MODELS_SLOT_CLEAR_DIALOG}="embeddings_slot"]`,
  );
  await expect(dialog).toHaveRole('alertdialog');
  await expect(dialog).toHaveAccessibleName('Clear Embeddings slot?');
  await expect(dialog).toContainText(
    'This deletes the settings and the key from this Recued server.',
  );
  const cancel = dialog.locator(
    `[${AI_MODELS_SLOT_CLEAR_CANCEL}="embeddings_slot"]`,
  );
  await expect(cancel).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setEmbeddingsSlot'),
  )).toBe(1);
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(clear).toBeFocused();

  await page.keyboard.press('Enter');
  dialog = page.locator(
    `[${AI_MODELS_SLOT_CLEAR_DIALOG}="embeddings_slot"]`,
  );
  const confirm = dialog.locator(
    `[${AI_MODELS_SLOT_CLEAR_CONFIRM}="embeddings_slot"]`,
  );
  const pendingCancel = dialog.locator(
    `[${AI_MODELS_SLOT_CLEAR_CANCEL}="embeddings_slot"]`,
  );
  await expect(pendingCancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__app.rpcCallCount('server.setEmbeddingsSlot') === 2,
  );
  await expect(dialog).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).toHaveText('Clearing slot…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(pendingCancel).toHaveAttribute('aria-disabled', 'true');
  await expect(pendingCancel).not.toHaveAttribute('disabled');
  await confirm.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await pendingCancel.evaluate((button: HTMLElement) => button.click());
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setEmbeddingsSlot'),
  )).toBe(2);
  await expect(dialog).toHaveCount(0);
  await expect(embeddings).toContainText('Not set up.');
  await expect(clear).toBeFocused();
});

test('Settings AI Models failed embeddings Clear stays owned and retryable', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai_embeddings_clear_response=fail-slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const embeddings = page.locator(
    '[data-recued-ai-models-control="embeddings_slot"]',
  );
  await embeddings.getByRole('combobox', { name: 'Embeddings slot protocol' })
    .selectOption('openai');
  await embeddings.getByRole('textbox', { name: 'Model' })
    .fill('text-embedding-3-small');
  await embeddings.locator(
    '[data-recued-ai-models-embeddings-field="api-key"]',
  ).fill('embedding-key');
  await embeddings.locator(
    '[data-recued-ai-models-slot-save="embeddings_slot"]',
  ).click();
  await page.waitForFunction(
    () => window.__app.rpcCallCount('server.setEmbeddingsSlot') === 1,
  );

  const clear = embeddings.locator(
    '[data-recued-ai-models-slot-clear="embeddings_slot"]',
  );
  await clear.click();
  const dialog = page.locator(
    `[${AI_MODELS_SLOT_CLEAR_DIALOG}="embeddings_slot"]`,
  );
  const confirm = dialog.locator(
    `[${AI_MODELS_SLOT_CLEAR_CONFIRM}="embeddings_slot"]`,
  );
  const cancel = dialog.locator(
    `[${AI_MODELS_SLOT_CLEAR_CANCEL}="embeddings_slot"]`,
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Clearing slot…');
  await expect(confirm).toBeFocused();

  await expect(page.locator('[data-recued-ai-models-action-error]'))
    .toHaveText('Embeddings slot clear unavailable.');
  await expect(dialog).toContainText('Embeddings slot clear unavailable.');
  await expect(confirm).toHaveText('Clear slot');
  await expect(confirm).not.toHaveAttribute('aria-disabled');
  await expect(confirm).not.toHaveAttribute('aria-busy');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(embeddings).not.toContainText('Not set up.');
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setEmbeddingsSlot'),
  )).toBe(2);

  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(clear).toBeFocused();
});

test('Settings AI Models pool removal is confirmed and keyboard-owned', async ({ page, browserName }) => {
  await page.goto(`${HARNESS_URL}?ai_pool=entry`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/ai-models'));
  await page.locator(`[${AI_MODELS_TAB}="providers"]`).click();

  const row = page.locator(
    '[data-recued-ai-models-control="free_pool:groq"]',
  );
  const remove = row.locator(
    '[data-recued-ai-models-pool-remove="groq"]',
  );
  await remove.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', {
    name: 'Remove groq from the free pool?',
  });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const confirm = dialog.getByRole('button', {
    name: 'Remove entry',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.removeFreePoolEntry'),
  )).toBe(0);

  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(cancel).toBeFocused();
  // WebKit's full keyboard navigation includes ordinary buttons.
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => window.__app.rpcCallCount('server.removeFreePoolEntry') === 1,
  );

  await expect(row).toHaveCount(0);
  await expect(page.getByRole('button', {
    name: 'Add free-pool API entry',
    exact: true,
  })).toBeFocused();
});
