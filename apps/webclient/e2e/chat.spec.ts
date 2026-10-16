import { expect, test } from '@playwright/test';
import { openChatHistory } from './helpers/chat-history.js';
import {
  ARTIFACTS, CHAT_ACTIVATION, CHAT_ACTIVATION_ACTION, CHAT_COMPOSER_ACTION,
  CHAT_HISTORY_LANDING, CHAT_INPUT, CHAT_MESSAGE, CHAT_SEND, CHAT_SESSION_ROW,
  CHAT_SETUP, CHAT_SOURCE_HANDOFF, DRAWER_LINK, DRAWER_TOGGLE, HARNESS_URL,
  RUN_PALETTE, installFullAppHooks,
} from './helpers/full-app.js';

/** Chat browser journeys against the deterministic full-app harness. */
const CHAT_ACTIVATION_CARD = 'data-recued-chat-route-activation-card';
const CHAT_ERROR = 'data-recued-chat-route-error';
const CHAT_NEW_SESSION = 'data-recued-chat-route-new-session';
const CHAT_MODEL_PICKER = 'data-recued-chat-route-model-picker';
const CHAT_COMPOSER_MORE = 'data-recued-chat-route-composer-more';
const CHAT_MAIL_NOTICE = 'data-recued-chat-route-mail-notice';
const CHAT_MAIL_NOTICE_DISMISS = 'data-recued-chat-route-mail-notice-dismiss';
const CHAT_MAIL_COMPOSE_PORTAL = 'data-recued-chat-route-mail-compose-portal';
const CHAT_THREAD = 'data-recued-chat-route-thread';
const CHAT_THREAD_TITLE = 'data-recued-chat-route-thread-title';
const CHAT_SESSION_ACTIONS = 'data-recued-chat-route-session-actions';
const CHAT_SESSION_EXPORT = 'data-recued-chat-route-session-export';
const CHAT_SESSION_DELETE = 'data-recued-chat-route-session-delete';
const CHAT_SESSION_DELETE_CONFIRM =
  'data-recued-chat-route-session-delete-confirm';
const CHAT_HISTORY_CONTINUE = 'data-recued-chat-route-history-continue';
const CHAT_HISTORY_SEARCH = 'data-recued-chat-route-history-search';
const CHAT_HISTORY_DRAFT_GUARD = 'data-recued-chat-route-history-draft-guard';
const CHAT_AI_UNAVAILABLE = 'data-recued-chat-route-ai-unavailable';
const CHAT_PLAN_CARD = 'data-recued-chat-route-plan-card';
const CHAT_PLAN_APPROVE = 'data-recued-chat-route-plan-approve';
const CHAT_PLAN_CANCEL = 'data-recued-chat-route-plan-cancel';
const CHAT_PLAN_CONTINUE = 'data-recued-chat-route-plan-continue';
const CHAT_PLAN_CONTEXT = 'data-recued-chat-route-plan-context';
const CHAT_DATA_DIAGNOSIS_ANSWER =
  'data-recued-chat-route-data-diagnosis-answer';
const CHAT_DATA_DIAGNOSIS_ANSWER_ACTION =
  'data-recued-chat-route-data-diagnosis-answer-action';
const CHAT_SETUP_MODEL = 'data-recued-ai-models-chat-setup-model';
const CHAT_SETUP_KEY = 'data-recued-ai-models-chat-setup-key';
const CHAT_SETUP_SUBMIT = 'data-recued-ai-models-chat-setup-submit';

installFullAppHooks();

test('the first-run Chat landing offers outcomes and seeds a prompt without sending', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const activation = page.locator(`[${CHAT_ACTIVATION}]`);
  await expect(activation).toBeVisible();
  // ⛔ D-267 — FOUR, and the ORDER is the assertion. `capture` leads because it
  // is the only card with no precondition: the other three each need a model,
  // an account, or a recipe, so before it a fresh install had nothing on this
  // screen it could actually do. ⚠ The vitest suite cannot catch a regression
  // here — its chat mount wires no upsert caller, so the fourth card never
  // appears there and a count ratchet stays green either way. This is the only
  // layer that runs the real composition with real callers.
  await expect(activation.locator(`[${CHAT_ACTIVATION_CARD}]`)).toHaveCount(4);
  await expect(
    activation.locator(`[${CHAT_ACTIVATION_CARD}]`).first(),
  ).toHaveAttribute(CHAT_ACTIVATION_CARD, 'capture');
  await expect(activation).toContainText('Start with your own');
  await expect(activation).toContainText('No setup needed');
  await expect(activation).toContainText('Ask Recued');
  await expect(activation).toContainText('Connect my work');
  await expect(activation).toContainText('Automate a task');
  // The grid must not orphan the fourth card onto a row of its own: the column
  // count follows the card count, so four render as 2×2 on a wide viewport.
  const rows = await activation
    .locator(`[${CHAT_ACTIVATION_CARD}]`)
    .evaluateAll((cards) =>
      new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size);
  expect(rows).toBe(2);

  await expect(
    activation.locator(`[${CHAT_ACTIVATION_ACTION}="connect"]`),
  ).toHaveAttribute('href', '#connections');
  await page.setViewportSize({ width: 390, height: 844 });
  await activation.locator(`[${CHAT_ACTIVATION_ACTION}="ask"]`).click();
  const input = page.locator(`[${CHAT_INPUT}]`);
  await expect(input).toHaveAccessibleName('Message to Recued');
  await expect(input).toHaveValue('Help me decide what to focus on today.');
  await expect(input).toBeFocused();

  const inputBox = await input.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(inputBox!.y).toBeGreaterThanOrEqual(-0.5);
  expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(844.5);
  const geometry = await activation.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: window.innerWidth };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 0.5);
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-first-run-mobile.png`,
    fullPage: true,
  });
});

test('Set up Chat saves a model, returns to Chat, and focuses the starter prompt', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai=empty&slow_ai=1`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const activation = page.locator(`[${CHAT_ACTIVATION}]`);
  const setupAction = activation.locator(
    `[${CHAT_ACTIVATION_ACTION}="ask"]`,
  );
  await expect(setupAction).toHaveText('Set up chat');
  await expect(setupAction).toHaveAttribute(
    'href',
    '#settings/ai-models/setup/start',
  );
  await setupAction.click();

  const setup = page.locator(`[${CHAT_SETUP}]`);
  await expect(setup).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up Chat' })).toBeVisible();
  await expect(setup).toContainText('Connect an AI to start chatting');
  await expect(
    setup.getByRole('combobox', { name: 'Provider', exact: true }),
  ).toHaveValue('openai');
  await expect(
    setup.getByRole('textbox', { name: 'Model', exact: true }),
  ).toHaveValue('gpt-4.1-mini');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-setup-mobile.png`,
    fullPage: true,
  });
  await page.locator(`[${CHAT_SETUP_KEY}]`).fill('sk-test-only');

  const model = page.locator(`[${CHAT_SETUP_MODEL}]`);
  await model.fill('会話モデル');
  await model.focus();
  const composingEnter = await model.evaluate((input) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    const dispatched = input.dispatchEvent(event);
    return { dispatched, defaultPrevented: event.defaultPrevented };
  });
  expect(composingEnter).toEqual({
    dispatched: true,
    defaultPrevented: false,
  });
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setLLMSlot'),
  )).toBe(0);

  const submit = page.locator(`[${CHAT_SETUP_SUBMIT}="new"]`);
  await expect(submit).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#chat\/start$/);
  const input = page.locator(`[${CHAT_INPUT}]`);
  await expect(input).toHaveValue('Help me decide what to focus on today.');
  await expect(input).toBeFocused();
  await expect(page.locator(`[${CHAT_ACTIVATION}]`)).toContainText('Model selected');

  const bounds = await input.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-0.5);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390.5);
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-setup-complete-mobile.png`,
    fullPage: true,
  });
});

test('Set up Chat owns its two-stage model handoff', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai=empty&ai_slot_save_response=slow&ai_default_model_pref_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    window.__app.setHash('#settings/ai-models/setup/start');
  });

  const setup = page.locator(`[${CHAT_SETUP}]`);
  const provider = setup.getByRole('combobox', {
    name: 'Provider',
    exact: true,
  });
  const key = page.locator(`[${CHAT_SETUP_KEY}]`);
  const submit = page.locator(`[${CHAT_SETUP_SUBMIT}="new"]`);
  await key.fill('sk-two-stage-test');
  await submit.focus();
  await page.keyboard.press('Enter');

  expect(await submit.evaluate((button) => ({
    text: button.textContent,
    ariaDisabled: button.getAttribute('aria-disabled'),
    ariaBusy: button.getAttribute('aria-busy'),
    nativeDisabled: (button as HTMLButtonElement).disabled,
    focused: document.activeElement === button,
  }))).toEqual({
    text: 'Saving setup…',
    ariaDisabled: 'true',
    ariaBusy: 'true',
    nativeDisabled: false,
    focused: true,
  });
  await expect(provider).toBeDisabled();
  await expect(key).toHaveAttribute('readonly', '');
  await submit.evaluate((button) => {
    (button as HTMLElement).click();
    (button as HTMLElement).click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('server.setLLMSlot')),
  ).toBe(1);

  const finishing = page.locator(
    '[data-recued-ai-models-chat-setup-status="saving"]',
  );
  await expect(finishing).toHaveText('Finishing off…');
  await expect(finishing).toHaveAttribute('tabindex', '-1');
  await expect(finishing).toBeFocused();
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.default_model_pref.set'),
    ),
  ).toBe(1);

  await expect(page).toHaveURL(/#chat\/start$/);
  await expect(page.locator(`[${CHAT_INPUT}]`)).toBeFocused();
});

test('Set up Chat returns a rejected slot write to the exact draft', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai=empty&ai_slot_save_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    window.__app.setHash('#settings/ai-models/setup/start');
  });

  const provider = page.getByRole('combobox', {
    name: 'Provider',
    exact: true,
  });
  const key = page.locator(`[${CHAT_SETUP_KEY}]`);
  const submit = page.locator(`[${CHAT_SETUP_SUBMIT}="new"]`);
  await key.fill('sk-retry-this-key');
  await submit.focus();
  await page.keyboard.press('Enter');
  await expect(submit).toHaveText('Saving setup…');
  await expect(submit).toBeFocused();

  await expect(page.locator(
    '[data-recued-ai-models-chat-setup-error="save"]',
  )).toHaveText('Model slot save unavailable.');
  await expect(key).toHaveValue('sk-retry-this-key');
  await expect(key).not.toHaveAttribute('readonly');
  await expect(provider).toBeEnabled();
  await expect(submit).toHaveText('Save and start chatting');
  await expect(submit).not.toHaveAttribute('aria-disabled');
  await expect(submit).not.toHaveAttribute('aria-busy');
  await expect(submit).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setLLMSlot'),
  )).toBe(1);
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.default_model_pref.set'),
  )).toBe(0);
});

test('Set up Chat returns a rejected default handoff to its surviving action', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?ai=empty&ai_slot_save_response=slow&ai_default_model_pref_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    window.__app.setHash('#settings/ai-models/setup/start');
  });

  await page.locator(`[${CHAT_SETUP_KEY}]`).fill('sk-saved-before-default');
  const save = page.locator(`[${CHAT_SETUP_SUBMIT}="new"]`);
  await save.focus();
  await page.keyboard.press('Enter');

  const finishing = page.locator(
    '[data-recued-ai-models-chat-setup-status="saving"]',
  );
  await expect(finishing).toHaveText('Finishing off…');
  await expect(finishing).toBeFocused();

  await expect(page.locator(
    '[data-recued-ai-models-chat-setup-error="save"]',
  )).toHaveText('Default model preference unavailable.');
  const retry = page.locator(`[${CHAT_SETUP_SUBMIT}="existing"]`);
  await expect(retry).toHaveText('Use this one and start chatting');
  await expect(retry).toBeEnabled();
  await expect(retry).toBeFocused();
  await expect(page).toHaveURL(/#settings\/ai-models\/setup\/start$/);
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('server.setLLMSlot'),
  )).toBe(1);
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.default_model_pref.set'),
  )).toBe(1);
});

test('Set up Chat returns a connected source to its useful first question', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai=empty&connection=source-ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    window.__app.setHash('#chat/source/mail/gmail/work');
  });

  const handoff = page.locator(`[${CHAT_SOURCE_HANDOFF}]`);
  await expect(handoff).toHaveAttribute('data-state', 'ready');
  const setupAction = handoff.getByRole('link', { name: 'Set up Chat' });
  await expect(setupAction).toHaveAttribute(
    'href',
    '#settings/ai-models/setup/source/mail/gmail/work',
  );
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue('');
  await setupAction.click();

  const setup = page.locator(`[${CHAT_SETUP}]`);
  await expect(setup).toBeVisible();
  await page.locator(`[${CHAT_SETUP_KEY}]`).fill('sk-test-only');
  await expect(page.locator(`[${CHAT_SETUP_SUBMIT}="new"]`)).toBeEnabled();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/#chat\/source\/mail\/gmail\/work$/);
  await expect(handoff).toHaveAttribute('data-state', 'ready');
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue(
    'Using my work mailbox, summarize what needs my attention and suggest the next three actions.',
  );
  await expect(page.locator(`[${CHAT_INPUT}]`)).toBeFocused();
  await expect(page.locator(`[${CHAT_ACTIVATION}]`)).toHaveCount(0);
});

test('Chat keeps an explicit source check focused through readiness', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?connection=source-check`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    window.__app.setHash('#chat/source/mail/gmail/work');
  });

  const handoff = page.locator(`[${CHAT_SOURCE_HANDOFF}]`);
  await expect(handoff).toHaveAttribute('data-state', 'pending');
  const initialReads = await page.evaluate(
    () => window.__app.rpcCallCount('collection.mail.list'),
  );
  const check = handoff.getByRole('button', { name: 'Check now' });
  await check.focus();
  await page.keyboard.press('Enter');

  const checking = handoff.getByRole('button', { name: 'Checking…' });
  await expect(checking).toBeFocused();
  await expect(checking).not.toHaveAttribute('disabled');
  await expect(checking).toHaveAttribute('aria-disabled', 'true');
  await expect(checking).toHaveAttribute('aria-busy', 'true');
  await checking.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('collection.mail.list'),
  )).toBe(initialReads + 1);

  await expect(handoff).toHaveAttribute('data-state', 'ready');
  await expect(handoff.getByRole('button', {
    name: 'Read the first question',
  })).toBeFocused();
});

test('Set up Chat returns an existing user to the thread they repaired', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?ai=empty&chat=session`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const session = page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`);
  await expect(session).toBeVisible();
  await session.click();

  const setupLink = page
    .locator(`[${CHAT_AI_UNAVAILABLE}]`)
    .getByRole('link', { name: /Set up Chat/ });
  await expect(setupLink).toHaveAttribute(
    'href',
    '#settings/ai-models/setup/session/chat_1',
  );
  await setupLink.click();
  const setup = page.locator(`[${CHAT_SETUP}]`);
  await expect(setup).toBeVisible();
  await expect(setup.getByRole('link', { name: 'Back to Chat' }))
    .toHaveAttribute('href', '#chat/session/chat_1');

  await page.locator(`[${CHAT_SETUP_KEY}]`).fill('sk-test-only');
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  await expect(session).toHaveAttribute('data-active', 'true');
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue('');

  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(session).toHaveAttribute('data-active', 'false');
});

test('a returning user can find, continue, reload, and leave an exact chat', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?chat=session`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const landing = page.locator(`[${CHAT_HISTORY_LANDING}]`);
  await expect(landing).toBeVisible();
  await expect(landing).toContainText('Continue “Planning chat”?');
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveCount(0);

  const search = page.locator(`[${CHAT_HISTORY_SEARCH}]`);
  await search.fill('planning');
  const session = page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`);
  await expect(session).toHaveCount(1);
  await search.fill('missing');
  await expect(session).toHaveCount(0);
  await search.fill('planning');

  await page.setViewportSize({ width: 390, height: 844 });
  await openChatHistory(page);
  const historyBounds = await search.boundingBox();
  expect(historyBounds).not.toBeNull();
  expect(historyBounds!.x).toBeGreaterThanOrEqual(-0.5);
  expect(historyBounds!.x + historyBounds!.width).toBeLessThanOrEqual(390.5);
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-history-mobile.png`,
    fullPage: true,
  });

  const sessionActions = page.locator(
    `[${CHAT_SESSION_ACTIONS}="chat_1"]`,
  );
  const sessionActionTrigger = sessionActions.locator('summary');
  await sessionActionTrigger.click();
  await expect(sessionActions).toHaveJSProperty('open', true);
  const resultsBounds = await page.locator('.chat-history-results').boundingBox();
  const menuBounds = await sessionActions
    .locator('.chat-session-action-menu')
    .boundingBox();
  expect(resultsBounds).not.toBeNull();
  expect(menuBounds).not.toBeNull();
  expect(menuBounds!.y).toBeGreaterThanOrEqual(resultsBounds!.y - 0.5);
  expect(menuBounds!.y + menuBounds!.height)
    .toBeLessThanOrEqual(resultsBounds!.y + resultsBounds!.height + 0.5);
  await page.keyboard.press('Escape');
  await expect(sessionActions).toHaveJSProperty('open', false);
  await expect(sessionActionTrigger).toBeFocused();

  await sessionActionTrigger.click();
  await expect(sessionActions).toHaveJSProperty('open', true);
  await search.click();
  await expect(sessionActions).toHaveJSProperty('open', false);
  await expect(search).toBeFocused();

  await page.locator('[data-recued-chat-route-history-toggle]').click();
  await page.locator(`[${CHAT_HISTORY_CONTINUE}]`).click();
  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  await expect(page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`))
    .toHaveAttribute('aria-current', 'page');

  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  await expect(page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`))
    .toHaveAttribute('aria-current', 'page');

  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  const newChat = page.locator(`[${DRAWER_LINK}="new-chat"]`);
  await expect(newChat).toHaveAttribute('href', '#chat/new');
  await newChat.click();
  await expect(page).toHaveURL(/#chat\/new$/);
  await expect(newChat).toHaveAttribute('aria-current', 'page');
  await expect(page.locator(`[${DRAWER_LINK}="chats"]`))
    .not.toHaveAttribute('aria-current', 'page');
  await expect(page.locator(`[${CHAT_INPUT}]`)).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  await expect(page.locator(`[${DRAWER_LINK}="chats"]`))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`))
    .toHaveAttribute('aria-current', 'page');
});

test('Chat contains long session titles and message tokens on a narrow phone', async ({ page }) => {
  const longTitle = `QuarterlyLaunchReadiness${'A'.repeat(120)}`;
  const longMessage = `https://example.test/${'B'.repeat(420)}`;
  await page.setViewportSize({ width: 280, height: 480 });
  await page.goto(
    `${HARNESS_URL}?chat=session&chat_title=${encodeURIComponent(longTitle)}#chat`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const landingTitle = page.locator('.chat-history-landing-title');
  await expect(landingTitle).toContainText(longTitle);
  const landingGeometry = await landingTitle.evaluate((node) => {
    const route = node.closest<HTMLElement>('[data-recued-chat-route]');
    return {
      right: node.getBoundingClientRect().right,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      routeScrollWidth: route?.scrollWidth ?? 0,
      routeClientWidth: route?.clientWidth ?? 0,
    };
  });
  expect(landingGeometry.right).toBeLessThanOrEqual(280.5);
  expect(landingGeometry.scrollWidth)
    .toBeLessThanOrEqual(landingGeometry.clientWidth);
  expect(landingGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(landingGeometry.routeClientWidth);

  await openChatHistory(page);
  await page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`).click();
  await page.evaluate((content) => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.message_complete',
        session_id: 'chat_1',
        turn_id: 'turn_long_content_1',
        final: {
          id: 'msg_long_content_1',
          session_id: 'chat_1',
          role: 'assistant',
          content,
          target_server: 'self',
          picker_at_send: {
            display_name: 'This server',
            signature: {
              server_kind: 'recued',
              version: 'test',
              instance_id: 'server-long-content',
            },
          },
          model_used: {
            provider: 'openai',
            model_id: 'gpt-4.1-mini',
          },
          contributor: 'model',
          ts: 1_700_000_000_010,
        },
        cursor: 1,
      },
    });
  }, longMessage);

  const threadTitle = page.locator(`[${CHAT_THREAD_TITLE}]`);
  const message = page.locator(
    `[${CHAT_MESSAGE}="msg_long_content_1"] .chat-message-content`,
  );
  await expect(threadTitle).toHaveText(longTitle);
  await expect(message).toHaveText(longMessage);
  const threadGeometry = await page.locator(`[${CHAT_THREAD}]`).evaluate(
    (thread) => {
      const route = thread.closest<HTMLElement>(
        '[data-recued-chat-route]',
      );
      const title = thread.querySelector('.chat-thread-title');
      const content = thread.querySelector('.chat-message-content');
      const send = thread.querySelector('[data-recued-chat-route-send]');
      const bounds = (node: Element | null) => {
        if (node === null) return null;
        const rect = node.getBoundingClientRect();
        const element = node as HTMLElement;
        return {
          left: rect.left,
          right: rect.right,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      };
      return {
        thread: bounds(thread),
        title: bounds(title),
        content: bounds(content),
        send: bounds(send),
        routeScrollWidth: route?.scrollWidth ?? 0,
        routeClientWidth: route?.clientWidth ?? 0,
      };
    },
  );
  for (const bounds of [
    threadGeometry.thread,
    threadGeometry.title,
    threadGeometry.content,
    threadGeometry.send,
  ]) {
    expect(bounds).not.toBeNull();
    expect(bounds!.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds!.right).toBeLessThanOrEqual(280.5);
    expect(bounds!.scrollWidth).toBeLessThanOrEqual(bounds!.clientWidth);
  }
  expect(threadGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(threadGeometry.routeClientWidth);
});

test('Chat preserves history search focus through a live session refresh', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?chat=session`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const search = page.locator(`[${CHAT_HISTORY_SEARCH}]`);
  await search.fill('planning');
  await expect(search).toBeFocused();
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('chat.sessions.list'),
  );
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'chat.session_changed',
      session_id: 'chat_1',
      field: 'title',
      value: 'Planning chat',
      cursor: 1,
    },
  }));

  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('chat.sessions.list')),
  ).toBe(before + 1);
  await expect(search).toHaveValue('planning');
  await expect(search).toBeFocused();
  await expect(page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`)).toHaveCount(1);
});

test('Chat preserves exact history row focus through a live session refresh', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?chat=session`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const row = page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`);
  await row.focus();
  await expect(row).toBeFocused();
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('chat.sessions.list'),
  );
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'chat.session_changed',
      session_id: 'chat_1',
      field: 'title',
      value: 'Planning chat',
      cursor: 1,
    },
  }));

  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('chat.sessions.list')),
  ).toBe(before + 1);
  await expect(row).toBeFocused();
});

test('Chat preserves an open history action through a live session refresh', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?chat=session`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const actions = page.locator(`[${CHAT_SESSION_ACTIONS}="chat_1"]`);
  await expect(actions).toHaveAccessibleName('Actions for Planning chat');
  await actions.locator('summary').click();
  const deleteAction = actions.getByRole('button', { name: 'Delete chat' });
  await deleteAction.focus();
  await expect(actions).toHaveJSProperty('open', true);
  await expect(deleteAction).toBeFocused();
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('chat.sessions.list'),
  );
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'chat.session_changed',
      session_id: 'chat_1',
      field: 'title',
      value: 'Planning chat',
      cursor: 1,
    },
  }));

  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('chat.sessions.list')),
  ).toBe(before + 1);
  await expect(actions).toHaveJSProperty('open', true);
  await expect(deleteAction).toBeFocused();
});

test('Chat keeps a slow history open focused and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session&hold_rpc=chat.session.get#chat`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await openChatHistory(page);

  const row = page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`);
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).not.toHaveAttribute('aria-disabled');
  await expect(row).toHaveAttribute('aria-busy', 'true');
  await expect(row).not.toHaveAttribute('disabled');
  await expect(row).toContainText('Opening…');
  await expect(row).toBeFocused();
  await row.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.session.get'),
  )).toBe(1);
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('chat.session.get')))
    .toBe(1);
  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  await expect(page.locator(`[${CHAT_INPUT}]`)).toBeFocused();
});

test('Chat returns a rejected history open to the exact row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session&chat_session_open_response=fail-slow#chat`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await openChatHistory(page);

  const row = page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`);
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).toContainText('Opening…');
  await expect(row).toBeFocused();

  await expect(page.locator(`[${CHAT_ERROR}]`)).toBeVisible();
  await expect(row).not.toContainText('Opening…');
  await expect(row).not.toHaveAttribute('aria-disabled');
  await expect(row).not.toHaveAttribute('aria-busy');
  await expect(row).not.toHaveAttribute('disabled');
  await expect(row).toBeFocused();
  await expect(page).toHaveURL(/#chat$/);
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.session.get'),
  )).toBe(1);
});

test('Chat lets a new draft supersede slow Continue without a late focus steal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session&hold_rpc=chat.session.get#chat`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const continueChat = page.locator(`[${CHAT_HISTORY_CONTINUE}]`);
  await continueChat.focus();
  await page.keyboard.press('Enter');
  await expect(continueChat).toHaveText('Opening chat…');
  await expect(continueChat).not.toHaveAttribute('aria-disabled');
  await expect(continueChat).toHaveAttribute('aria-busy', 'true');
  await expect(continueChat).not.toHaveAttribute('disabled');
  await expect(continueChat).toBeFocused();
  const sidebarNew = page.locator(`[${CHAT_NEW_SESSION}]`);
  const startNew = page.getByRole('button', { name: 'Start a new chat' });
  await expect(sidebarNew).not.toHaveAttribute('aria-disabled');
  await expect(startNew).not.toHaveAttribute('aria-disabled');
  await continueChat.evaluate((button: HTMLElement) => button.click());
  await startNew.focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.session.get'),
  )).toBe(1);
  await expect(page).toHaveURL(/#chat\/new$/);
  await expect(page.locator(`[${CHAT_INPUT}]`)).toBeFocused();
  await page.keyboard.type('Keep this newer draft');
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('chat.session.get')))
    .toBe(1);
  await expect(page).toHaveURL(/#chat\/new$/);
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue('Keep this newer draft');
  await expect(page.locator(`[${CHAT_INPUT}]`)).toBeFocused();
});

test('Chat returns rejected Continue to its exact retry command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session&chat_session_open_response=fail-slow#chat`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const continueChat = page.locator(`[${CHAT_HISTORY_CONTINUE}]`);
  await continueChat.focus();
  await page.keyboard.press('Enter');
  await expect(continueChat).toHaveText('Opening chat…');
  await expect(continueChat).toBeFocused();

  await expect(page.locator(`[${CHAT_ERROR}]`)).toBeVisible();
  await expect(continueChat).toHaveText('Continue chat');
  await expect(continueChat).not.toHaveAttribute('aria-disabled');
  await expect(continueChat).not.toHaveAttribute('aria-busy');
  await expect(continueChat).not.toHaveAttribute('disabled');
  await expect(continueChat).toBeFocused();
  await expect(page).toHaveURL(/#chat$/);
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.session.get'),
  )).toBe(1);
});

test('Chat keeps pending export feedback visible, focused, and single-flight', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?chat=session`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const actions = page.locator(`[${CHAT_SESSION_ACTIONS}="chat_1"]`);
  await actions.locator('summary').click();
  const exportAction = actions.locator(
    `[${CHAT_SESSION_EXPORT}="chat_1"]`,
  );
  await exportAction.click();

  await expect(actions).toHaveAttribute('open', '');
  await expect(exportAction).toHaveText('Exporting…');
  await expect(exportAction).toHaveAttribute('aria-disabled', 'true');
  await expect(exportAction).toHaveAttribute('aria-busy', 'true');
  await expect(exportAction).not.toHaveAttribute('disabled', '');
  await expect(exportAction).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.session.export'),
  )).toBe(1);

  await page.keyboard.press('Enter');
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.session.export'),
  )).toBe(1);
});

test('Chat keeps a pending delete confirmation focused and single-flight', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?chat=session`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const actions = page.locator(`[${CHAT_SESSION_ACTIONS}="chat_1"]`);
  await actions.locator('summary').click();
  await actions.getByRole('button', { name: 'Delete chat' }).click();
  const confirm = page.locator(
    `[${CHAT_SESSION_DELETE_CONFIRM}="chat_1"]`,
  );
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(confirm).toHaveText('Deleting…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled', '');
  await expect(confirm).toBeFocused();
  const newChat = page.locator(`[${CHAT_NEW_SESSION}]`);
  await expect(newChat).toHaveAttribute('aria-disabled', 'true');
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.session.delete'),
  )).toBe(1);

  await page.keyboard.press('Enter');
  await newChat.dispatchEvent('click');
  await expect(confirm).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.session.delete'),
  )).toBe(1);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    window.__app.setHash('#data');
  });
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Something is still happening in your chat history. Leave anyway?',
  );
  await expect.poll(
    () => page.evaluate(() => window.location.hash),
  ).toBe('');
  await expect(confirm).toBeFocused();
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Chat returns rejected history actions to visible retry controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session&chat_history_action_response=fail`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await openChatHistory(page);

  const actions = page.locator(`[${CHAT_SESSION_ACTIONS}="chat_1"]`);
  await actions.locator('summary').click();
  const exportAction = actions.locator(`[${CHAT_SESSION_EXPORT}="chat_1"]`);
  await exportAction.click();

  await expect(page.getByRole('alert')).toContainText(
    "Recued could not save this chat to a file",
  );
  await expect(actions).toHaveAttribute('open', '');
  await expect(exportAction).toBeFocused();
  await expect(exportAction).toBeInViewport();

  const deleteAction = actions.locator(`[${CHAT_SESSION_DELETE}="chat_1"]`);
  await deleteAction.click();
  const confirm = page.locator(
    `[${CHAT_SESSION_DELETE_CONFIRM}="chat_1"]`,
  );
  await confirm.click();

  await expect(page.getByRole('alert')).toContainText(
    "Recued could not delete this chat",
  );
  await expect(actions).toHaveAttribute('open', '');
  await expect(deleteAction).toBeFocused();
  await expect(deleteAction).toBeInViewport();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.session.export'),
  )).toBe(1);
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('chat.session.delete'),
  )).toBe(1);
});

test('Chat Escape cancels the unsent-draft guard and returns to writing', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?chat=session#chat/new`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const input = page.locator(`[${CHAT_INPUT}]`);
  await input.fill('Keep this unfinished thought');
  const newChat = page.locator(`[${CHAT_NEW_SESSION}]`);
  await newChat.focus();
  await page.keyboard.press('Enter');

  const guard = page.locator(`[${CHAT_HISTORY_DRAFT_GUARD}]`);
  await expect(guard).toBeVisible();
  await expect(guard).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(guard).toHaveCount(0);
  await expect(input).toHaveValue('Keep this unfinished thought');
  await expect(input).toBeFocused();
  await expect(page).toHaveURL(/#chat\/new$/);
});

test('New chat on a blank draft returns focus to the composer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?chat=session#chat/new`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const conversation = page.getByRole('region', {
    name: 'Chat conversation',
  });
  await expect(conversation).toBeVisible();
  await expect(conversation.getByRole('heading', {
    name: 'What can Recued help you with?',
    level: 2,
  })).toBeVisible();

  const input = page.locator(`[${CHAT_INPUT}]`);
  const newChat = page.locator(`[${CHAT_NEW_SESSION}]`);
  await newChat.focus();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/#chat\/new$/);
  await expect(input).toBeFocused();
  await expect.poll(async () => page.evaluate(() =>
    window.__app.rpcCallCount('chat.session.create'))).toBe(0);
});

test('Chat model selection retains focus in drafts and saved sessions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?ai=two&chat=session#chat/new`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const picker = page.locator(`[${CHAT_MODEL_PICKER}]`);
  await expect(picker.locator('option')).toHaveCount(2);
  await picker.focus();
  await picker.selectOption('slot_2');
  await expect(picker).toHaveValue('slot_2');
  await expect(picker).toBeFocused();

  await page.evaluate(() => window.__app.setHash('#chat/session/chat_1'));
  await expect(page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`))
    .toHaveAttribute('aria-current', 'page');
  await picker.focus();
  await picker.selectOption('slot_2');
  await expect.poll(async () => page.evaluate(() =>
    window.__app.rpcCallCount('chat.session.set_model_pref'))).toBe(1);
  await expect(picker).toHaveValue('slot_2');
  await expect(picker).toBeFocused();
});

test('Chat keeps an exact same-speed model slot through live updates', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?ai=two&chat=session&chat_model_sources=same-speed-slot-2#chat/session/chat_1`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const picker = page.locator(`[${CHAT_MODEL_PICKER}]`);
  await expect(picker.locator('option')).toHaveCount(2);
  await expect(picker).toHaveValue('slot_2');
  await picker.focus();

  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'chat.session_changed',
      session_id: 'chat_1',
      field: 'model_pref',
      value: {
        current: 'byok',
        model_hint: 'fast',
        source_id: 'slot_1',
        overridden: true,
      },
      cursor: 101,
    },
  }));
  await expect(picker).toHaveValue('slot_1');
  await expect(picker).toBeFocused();

  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'chat.session_changed',
      session_id: 'chat_1',
      field: 'model_pref',
      value: {
        current: 'byok',
        model_hint: 'fast',
        source_id: 'slot_2',
        overridden: true,
      },
      cursor: 102,
    },
  }));
  await expect(picker).toHaveValue('slot_2');
  await expect(picker).toBeFocused();
});

test('Chat serializes rapid model changes with the latest choice visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?ai=two&chat=session&chat_model_pref_response=slow#chat/session/chat_1`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const picker = page.locator(`[${CHAT_MODEL_PICKER}]`);
  await expect(picker).toHaveValue('slot_1');
  await picker.focus();
  await picker.selectOption('slot_2');
  await expect(picker).toHaveValue('slot_2');
  await expect(picker).toHaveAttribute('aria-busy', 'true');
  await expect(picker).toBeFocused();

  await picker.selectOption('slot_1');
  await expect(picker).toHaveValue('slot_1');
  await expect(picker).toHaveAttribute('aria-busy', 'true');
  await expect(picker).toBeFocused();
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('chat.session.set_model_pref'))).toBe(1);

  await expect.poll(async () => page.evaluate(() =>
    window.__app.rpcCallCount('chat.session.set_model_pref'))).toBe(2);
  await expect(picker).not.toHaveAttribute('aria-busy', 'true');
  await expect(picker).toHaveValue('slot_1');
  await expect(picker).toBeFocused();
});

test('Chat retains a model change across tab and route leave', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?ai=two&chat=session&chat_model_pref_response=slow`
    + '#chat/session/chat_1',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const picker = page.locator(`[${CHAT_MODEL_PICKER}]`);
  await picker.focus();
  await picker.selectOption('slot_2');
  await expect(picker).toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return window.dispatchEvent(event);
  })).toBe(false);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    window.__app.setHash('#data');
  });

  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Recued is still changing which AI you use. Leave anyway?',
  );
  await expect.poll(() => page.evaluate(() => window.location.hash))
    .toBe('#chat/session/chat_1');
  await expect(picker).toHaveValue('slot_2');
  await expect(picker).toBeFocused();
  await expect(picker).not.toHaveAttribute('aria-busy', 'true');

  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return window.dispatchEvent(event);
  })).toBe(true);
  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Chat announces a rejected send and keeps its draft ready to retry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session&chat_send_response=fail-once#chat/session/chat_1`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const input = page.locator(`[${CHAT_INPUT}]`);
  const send = page.locator(`[${CHAT_SEND}]`);
  await input.fill('Keep this retryable message');
  await send.click();

  const error = page.locator(`[${CHAT_ERROR}]`);
  await expect(error).toBeVisible();
  await expect(error).toBeInViewport();
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(input).toHaveValue('Keep this retryable message');
  await expect(input).toBeFocused();
  await expect(send).toBeEnabled();
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('chat.send'))).toBe(1);

  await send.click();
  await expect.poll(async () => page.evaluate(() =>
    window.__app.rpcCallCount('chat.send'))).toBe(2);
  await expect(error).toHaveCount(0);
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
});

test('Chat exposes Send only when the composer has a message', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?chat=session#chat/new`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const input = page.locator(`[${CHAT_INPUT}]`);
  const send = page.locator(`[${CHAT_SEND}]`);
  await expect(input).toHaveValue('');
  await expect(send).toBeDisabled();

  await input.fill('   ');
  await expect(send).toBeDisabled();
  await input.fill('Draft the customer follow-up');
  await expect(send).toBeEnabled();
  await input.fill('');
  await expect(send).toBeDisabled();
  expect(await page.evaluate(() => ({
    sessions: window.__app.rpcCallCount('chat.session.create'),
    sends: window.__app.rpcCallCount('chat.send'),
  }))).toEqual({ sessions: 0, sends: 0 });
});

test('Chat sends from the keyboard without stealing multiline entry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?chat=session&hold_rpc=chat.send#chat/session/chat_1`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const conversation = page.getByRole('region', {
    name: 'Chat conversation',
  });
  const input = page.locator(`[${CHAT_INPUT}]`);
  const send = page.locator(`[${CHAT_SEND}]`);
  await expect(send).toHaveAttribute(
    'aria-keyshortcuts',
    'Control+Enter Meta+Enter',
  );
  await input.fill('First line');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Second line');
  await expect(input).toHaveValue('First line\nSecond line');
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('chat.send'))).toBe(0);

  await page.keyboard.press('Control+Enter');
  await expect.poll(async () => page.evaluate(() =>
    window.__app.rpcCallCount('chat.send'))).toBe(1);
  await expect(send).toHaveText('Sending...');
  await expect(input).toHaveValue('First line\nSecond line');
  await expect(input).toBeFocused();
  await expect(input).toBeEnabled();
  await expect(send).toBeDisabled();

  // Duplicate dispatch is blocked only until the server acknowledges it.
  await page.keyboard.press('Control+Enter');
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('chat.send'))).toBe(1);
  expect(await page.evaluate(() =>
    window.__app.releaseRpcResponses?.('chat.send'))).toBe(1);
  await expect(send).toHaveText('Send');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(conversation.getByRole('heading', {
    name: 'Planning chat',
    level: 2,
  })).toBeVisible();

  // Acknowledgement permits another instruction while the first turn runs.
  await input.fill('Queued next thought');
  await expect(send).toBeEnabled();
  await page.keyboard.press('Meta+Enter');
  await expect.poll(async () => page.evaluate(() =>
    window.__app.rpcCallCount('chat.send'))).toBe(2);
  await expect(send).toHaveText('Sending...');
  await page.keyboard.press('Meta+Enter');
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('chat.send'))).toBe(2);
  await expect(input).toHaveValue('Queued next thought');
});

test('Chat send keeps the editable composer through ack and completion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?chat=session&hold_rpc=chat.send#chat/session/chat_1`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const input = page.locator(`[${CHAT_INPUT}]`);
  const send = page.locator(`[${CHAT_SEND}]`);
  await input.fill('Follow up on this plan');
  await send.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => page.evaluate(() =>
    window.__app.rpcCallCount('chat.send'))).toBe(1);
  await expect(send).toHaveText('Sending...');
  await expect(input).toHaveValue('Follow up on this plan');
  await expect(input).toBeFocused();
  await expect(input).toBeEnabled();

  // Edits made before acknowledgement belong to the next message.
  await input.fill('Keep this next thought');
  await input.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(5, 5);
  });
  expect(await page.evaluate(() =>
    window.__app.releaseRpcResponses?.('chat.send'))).toBe(1);
  await expect(send).toHaveText('Send');
  await expect(send).toBeEnabled();
  await expect(input).toHaveValue('Keep this next thought');
  await expect(input).toBeFocused();
  expect(await input.evaluate((element: HTMLTextAreaElement) =>
    [element.selectionStart, element.selectionEnd])).toEqual([5, 5]);

  const newChat = page.locator(`[${CHAT_NEW_SESSION}]`);
  const activeHistory = page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`);
  await expect(activeHistory).toContainText('Working…');
  await expect(newChat).not.toHaveAttribute('aria-disabled');
  await expect(newChat).not.toHaveAttribute('disabled');
  await expect(activeHistory).not.toHaveAttribute('aria-disabled');
  await expect(activeHistory).not.toHaveAttribute('disabled');
  // The unsent draft stays with its conversation while accepted work continues.
  await openChatHistory(page);
  await newChat.click();
  await expect(page.locator(`[${CHAT_HISTORY_DRAFT_GUARD}]`)).toHaveCount(0);
  await expect(page).toHaveURL(/#chat\/new$/);
  await expect(input).toHaveValue('');
  await expect(activeHistory.locator('[data-chat-session-draft]')).toHaveText('Draft');
  await openChatHistory(page);
  await activeHistory.click();
  await expect(input).toHaveValue('Keep this next thought');
  await input.focus();
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 'turn_plan_continue_1',
      final: {
        id: 'msg_send_focus',
        session_id: 'chat_1',
        role: 'assistant',
        content: 'The first answer is complete.',
        target_server: 'self',
        picker_at_send: {
          display_name: 'This server',
          signature: {
            server_kind: 'recued',
            version: 'test',
            instance_id: 'server-send-focus',
          },
        },
        model_used: {
          provider: 'openai',
          model_id: 'gpt-4.1-mini',
        },
        contributor: 'model',
        ts: 1_700_000_000_010,
      },
      cursor: 1,
    },
  }));

  await expect(send).toHaveText('Send');
  await expect(input).toHaveValue('Keep this next thought');
  await expect(input).toBeFocused();
  await expect(activeHistory).not.toContainText('Working…');
  await expect(newChat).not.toHaveAttribute('aria-disabled');
  await expect(activeHistory).not.toHaveAttribute('aria-disabled');
  await openChatHistory(page);
  await newChat.click();
  await expect(page.locator(`[${CHAT_HISTORY_DRAFT_GUARD}]`)).toHaveCount(0);
  await expect(input).toHaveValue('');
  await openChatHistory(page); await activeHistory.click();
  await expect(input).toHaveValue('Keep this next thought');
});

test('Chat preserves its Activity disclosure through owner and live repaints', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?chat=session#chat/session/chat_1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'chat.tool_call_started',
      session_id: 'chat_1',
      turn_id: 'turn_activity_focus',
      tool_name: 'mail.search',
      tier: 1,
      args: { query: 'needs attention' },
      cursor: 1,
    },
  }));

  const toggle = page.locator('[data-recued-chat-route-activity-toggle]');
  await expect(toggle).toHaveText('▾ Activity (1)');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveText('▸ Activity (1)');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();

  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'chat.tool_call_completed',
      session_id: 'chat_1',
      turn_id: 'turn_activity_focus',
      tool_name: 'mail.search',
      tier: 1,
      status: 'ok',
      result_ref: 'chat_1:turn_activity_focus:mail.search',
      cursor: 2,
    },
  }));
  await expect(toggle).toHaveText('▸ Activity (1)');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(toggle).toHaveText('▾ Activity (1)');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();
  await expect(page.locator('[data-recued-chat-route-activity-row]'))
    .toContainText('used mail.search');
});

test('Chat contains long live Activity text on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 480 });
  await page.goto(`${HARNESS_URL}?chat=session#chat/session/chat_1`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const note = `Inspecting${'N'.repeat(420)}`;
  const toolName = `community.${'T'.repeat(420)}`;
  await page.evaluate(({ note, toolName }) => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.transparency',
        session_id: 'chat_1',
        turn_id: 'turn_long_activity_1',
        event: { kind: 'chat.channel_note', note },
        cursor: 1,
      },
    });
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.tool_call_started',
        session_id: 'chat_1',
        turn_id: 'turn_long_activity_1',
        tool_name: toolName,
        tier: 1,
        args: {},
        cursor: 2,
      },
    });
  }, { note, toolName });

  const activity = page.locator('[data-recued-chat-route-activity]');
  const rows = activity.locator('[data-recued-chat-route-activity-row]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText(note);
  await expect(rows.nth(1)).toContainText(toolName);
  const geometry = await activity.evaluate((node) => {
    const route = node.closest<HTMLElement>('[data-recued-chat-route]');
    const elements = [
      node,
      ...node.querySelectorAll<HTMLElement>(
        '[data-recued-chat-route-activity-row]',
      ),
    ];
    return {
      elements: elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      }),
      routeScrollWidth: route?.scrollWidth ?? 0,
      routeClientWidth: route?.clientWidth ?? 0,
    };
  });
  for (const bounds of geometry.elements) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }
  expect(geometry.routeScrollWidth)
    .toBeLessThanOrEqual(geometry.routeClientWidth);
});

test('the docked Chat composer action menu dismisses predictably', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session#chat/session/chat_1`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const input = page.locator(`[${CHAT_INPUT}]`);
  const expandedActions = page.locator(`[${CHAT_COMPOSER_ACTION}]`);
  const expandedHeights = await expandedActions.evaluateAll((actions) =>
    actions.map((action) => action.getBoundingClientRect().height)
  );
  expect(Math.min(...expandedHeights)).toBeGreaterThanOrEqual(36);
  await input.fill('Check the composer actions');
  await page.locator(`[${CHAT_SEND}]`).click();

  const more = page.locator(`[${CHAT_COMPOSER_MORE}]`);
  const trigger = more.locator('summary');
  await expect(more).toBeVisible();
  await expect(more).toHaveAccessibleName('Things you can do here');
  await expect(trigger).toHaveAccessibleName('More Things you can do here');
  expect((await trigger.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await expect(more).toContainText('Run a Recipe');
  await expect(more).toContainText('Create');

  await trigger.click();
  await expect(more).toHaveJSProperty('open', true);
  await expect(more.getByRole('button', {
    name: 'Run a Recipe',
    exact: true,
  })).toHaveCount(1);
  await expect(more.getByRole('button', {
    name: 'Create',
    exact: true,
  })).toHaveCount(1);
  const menuHeights = await more.getByRole('button').evaluateAll((actions) =>
    actions.map((action) => action.getBoundingClientRect().height)
  );
  expect(Math.min(...menuHeights)).toBeGreaterThanOrEqual(36);
  await page.keyboard.press('Escape');
  await expect(more).toHaveJSProperty('open', false);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(more).toHaveJSProperty('open', true);
  await input.click();
  await expect(more).toHaveJSProperty('open', false);
  await expect(input).toBeFocused();
});

test('New mail reports a missing mailbox in Chat without asking Chat', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?chat=session#chat/session/chat_1`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const mailReadsBefore = await page.evaluate(() =>
    window.__app.rpcCallCount('collection.mail.list'));
  await page.locator(`[${CHAT_COMPOSER_ACTION}="mail"]`).click();

  const notice = page.locator(`[${CHAT_MAIL_NOTICE}="none"]`);
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('role', 'status');
  await expect(notice).toContainText('Connect a mailbox');
  await expect(notice.getByRole('link', { name: 'Connect mail' }))
    .toHaveAttribute('href', '#connections/mail');
  await expect(page.locator(`[${CHAT_MAIL_COMPOSE_PORTAL}] .mail-compose-dialog`))
    .toHaveCount(0);
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('collection.mail.list'))).toBe(mailReadsBefore + 1);
  expect(await page.evaluate(() => ({
    asks: window.__app.rpcCallCount('chat.send'),
    runs: window.__app.rpcCallCount('execute'),
  }))).toEqual({ asks: 0, runs: 0 });

  await page.locator(`[${CHAT_MAIL_NOTICE_DISMISS}]`).click();
  await expect(notice).toHaveCount(0);
});

test('a docked Chat child overlay returns focus to the visible action trigger', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session#chat/session/chat_1`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.locator(`[${CHAT_INPUT}]`).fill('Open the run palette');
  await page.locator(`[${CHAT_SEND}]`).click();

  const more = page.locator(`[${CHAT_COMPOSER_MORE}]`);
  const trigger = more.locator('summary');
  await trigger.click();
  const run = more.locator(`[${CHAT_COMPOSER_ACTION}="run"]`);
  await run.focus();
  await page.keyboard.press('Enter');

  const overlay = page.locator(`[${RUN_PALETTE}]`);
  await expect(overlay).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(overlay).toHaveCount(0);
  await expect(more).toHaveJSProperty('open', false);
  await expect(trigger).toBeFocused();
});

test('Chat contains long reviewed-action identifiers on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 480 });
  await page.goto(`${HARNESS_URL}?chat=session#chat/session/chat_1`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const tool = `community.${'x'.repeat(400)}`;
  const argumentKey = `destination_${'identifier'.repeat(30)}`;
  const argumentValue = `https://example.test/${'V'.repeat(420)}`;
  await page.evaluate(({ tool, argumentKey, argumentValue }) => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.plan_proposed',
        session_id: 'chat_1',
        turn_id: 'turn_long_plan_1',
        plan_id: 'plan_long_identifiers_1',
        tool,
        tier: 2,
        args: { [argumentKey]: argumentValue },
        cursor: 1,
      },
    });
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.message_complete',
        session_id: 'chat_1',
        turn_id: 'turn_long_plan_1',
        final: {
          id: 'msg_long_plan_1',
          session_id: 'chat_1',
          role: 'assistant',
          content: 'Please review this action.',
          target_server: 'self',
          picker_at_send: {
            display_name: 'This server',
            signature: {
              server_kind: 'recued',
              version: 'test',
              instance_id: 'server-long-plan',
            },
          },
          model_used: {
            provider: 'openai',
            model_id: 'gpt-4.1-mini',
          },
          contributor: 'model',
          ts: 1_700_000_000_010,
        },
        cursor: 2,
      },
    });
  }, { tool, argumentKey, argumentValue });

  const card = page.locator(
    `[${CHAT_PLAN_CARD}][data-plan-id="plan_long_identifiers_1"]`,
  );
  await expect(card).toContainText('Needs a look');
  await card.locator('.chat-plan-card-technical summary').click();
  const geometry = await card.evaluate((node) => {
    const route = node.closest<HTMLElement>('[data-recued-chat-route]');
    const bounds = (selector: string) => {
      const element = node.querySelector<HTMLElement>(selector);
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    };
    const cardRect = node.getBoundingClientRect();
    return {
      card: {
        left: cardRect.left,
        right: cardRect.right,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      },
      tool: bounds('.chat-plan-card-tool'),
      details: bounds('.chat-plan-card-details'),
      key: bounds('.chat-plan-card-detail-key'),
      value: bounds('.chat-plan-card-detail-value'),
      technical: bounds('.chat-plan-card-technical-meta'),
      routeScrollWidth: route?.scrollWidth ?? 0,
      routeClientWidth: route?.clientWidth ?? 0,
    };
  });
  for (const bounds of [
    geometry.card,
    geometry.tool,
    geometry.details,
    geometry.key,
    geometry.value,
    geometry.technical,
  ]) {
    expect(bounds).not.toBeNull();
    expect(bounds!.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds!.right).toBeLessThanOrEqual(280.5);
    expect(bounds!.scrollWidth).toBeLessThanOrEqual(bounds!.clientWidth);
  }
  expect(geometry.routeScrollWidth)
    .toBeLessThanOrEqual(geometry.routeClientWidth);
});

test('a reviewed write stays explicit from approval through the Chat handoff', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?chat=session&chat_plan_response=slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await openChatHistory(page);

  const session = page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`);
  await session.click();
  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.plan_proposed',
        session_id: 'chat_1',
        turn_id: 'turn_plan_1',
        plan_id: 'plan_email_1',
        tool: 'mail.send',
        tier: 2,
        args: {
          to: 'mary@example.com',
          subject: 'Quarterly planning follow-up',
          body: 'Thanks for the update. I’ll review this before Friday.',
        },
        cursor: 1,
      },
    });
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.message_complete',
        session_id: 'chat_1',
        turn_id: 'turn_plan_1',
        final: {
          id: 'msg_plan_1',
          session_id: 'chat_1',
          role: 'assistant',
          content: 'I prepared the reply for your review.',
          target_server: 'self',
          picker_at_send: {
            display_name: 'This server',
            signature: {
              server_kind: 'recued',
              version: 'test',
              instance_id: 'server-plan-review',
            },
          },
          model_used: {
            provider: 'openai',
            model_id: 'gpt-4.1-mini',
          },
          contributor: 'model',
          ts: 1_700_000_000_010,
        },
        cursor: 2,
      },
    });
  });

  const card = page.locator(
    `[${CHAT_PLAN_CARD}][data-plan-id="plan_email_1"]`,
  );
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-status', 'proposed');
  await expect(card).toContainText('Needs a look');
  await expect(card).toContainText('Send email');
  await expect(card).toContainText(
    'Saying yes lets Chat do it once, with exactly these details. '
    + 'It does not run it yet.',
  );
  await expect(card.locator('.chat-plan-card-detail')).toHaveCount(3);
  await expect(card).toContainText('mary@example.com');
  await expect(card).toContainText('Quarterly planning follow-up');
  await expect(card.locator('details')).not.toHaveAttribute('open', '');
  const technical = card.locator('.chat-plan-card-technical');
  const technicalTrigger = technical.locator('summary');
  const technicalSummary = await technicalTrigger.boundingBox();
  expect(technicalSummary?.height).toBeGreaterThanOrEqual(36);
  await technicalTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(technical).toHaveAttribute('open', '');
  await expect(technicalTrigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(technical).not.toHaveAttribute('open', '');
  await expect(technicalTrigger).toBeFocused();
  await expect(card).toContainText('Tool: mail.send · Tier 2');
  await expect(card.getByRole('button', { name: 'Say yes, once' })).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Don’t approve' }),
  ).toBeVisible();
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-plan-review-mobile.png`,
    fullPage: true,
  });

  const approve = card.locator(`[${CHAT_PLAN_APPROVE}]`);
  await approve.focus();
  await approve.click();
  await expect(approve).toHaveText('Approving…');
  await expect(approve).toBeFocused();
  await expect(approve).not.toHaveAttribute('disabled');
  await expect(approve).toHaveAttribute('aria-disabled', 'true');
  await expect(approve).toHaveAttribute('aria-busy', 'true');
  await expect(card.locator(`[${CHAT_PLAN_CANCEL}]`)).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await approve.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('chat.plan.approve'),
  )).toBe(1);
  await expect(card).toHaveAttribute('data-status', 'approved');
  await expect(card).toContainText('Approved once');
  await expect(card).toContainText(
    'Carry on in Chat when you are ready to ask Chat to do it.',
  );
  await expect(page.locator(`[${CHAT_PLAN_CONTEXT}]`)).toHaveCount(0);
  await expect(card.locator(`[${CHAT_PLAN_CONTINUE}]`)).toBeFocused();

  await card.locator(`[${CHAT_PLAN_CONTINUE}]`).click();
  const input = page.locator(`[${CHAT_INPUT}]`);
  await expect(input).toHaveValue(
    /Continue with the approved action below\.[\s\S]*Tool: mail\.send/,
  );
  const continuationDraft = await input.inputValue();
  expect(continuationDraft).toContain(
    '"to": "mary@example.com"',
  );
  expect(continuationDraft).toContain(
    '"subject": "Quarterly planning follow-up"',
  );
  expect(continuationDraft).toContain('<reviewed_arguments>');
  expect(continuationDraft).toContain('</reviewed_arguments>');
  expect(continuationDraft).toContain(
    'If you cannot use it exactly, ask me before changing anything.',
  );
  await expect(input).toBeFocused();
  const context = page.locator(`[${CHAT_PLAN_CONTEXT}]`);
  await expect(context).toBeVisible();
  await expect(context).toContainText('Send email · approved once');
  await expect(context).toContainText(
    'If what it wants to do changes, you will see it again.',
  );
  await expect(page.locator(`[${CHAT_SEND}]`)).toHaveText('Continue');
  await expect(card).toContainText(
    'A message is ready in the box. Read it, then send it when you are ready.',
  );
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-plan-continuation-mobile.png`,
    fullPage: true,
  });

  await page.locator(`[${CHAT_SEND}]`).click();
  await expect(context).toHaveCount(0);
  await expect(card.locator(`[${CHAT_PLAN_CONTINUE}]`)).toHaveCount(0);
  await expect(card).toContainText(
    'Sent to Chat. If what it wants to do changes, Chat will '
    + 'ask you again.',
  );
});

test('a safe-check closure keeps focus on its durable receipt', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session&chat_diagnosis_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await openChatHistory(page);
  await page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`).click();

  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.plan_proposed',
        session_id: 'chat_1',
        turn_id: 'turn_safe_check',
        plan_id: 'plan_safe_check',
        tool: 'mail.send',
        tier: 2,
        args: { to: 'customer@example.com', subject: 'Follow-up' },
        cursor: 1,
      },
    });
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.message_complete',
        session_id: 'chat_1',
        turn_id: 'turn_safe_check',
        final: {
          id: 'msg_safe_check',
          session_id: 'chat_1',
          role: 'assistant',
          content: 'The read-only check found the expected calendar record.',
          target_server: 'self',
          picker_at_send: {
            display_name: 'This server',
            signature: {
              server_kind: 'recued',
              version: 'test',
              instance_id: 'server-safe-check',
            },
          },
          model_used: {
            provider: 'openai',
            model_id: 'gpt-4.1-mini',
          },
          data_diagnosis: {
            kind: 'data_verification',
            plan_id: 'plan_safe_check',
            run_id: 'run-verify',
            intent: 'safe_check',
            relationship: 'involved',
            run_correlation: 'matched',
          },
          contributor: 'model',
          ts: 1_700_000_000_100,
        },
        cursor: 2,
      },
    });
  });

  const receipt = page.locator(`[${CHAT_DATA_DIAGNOSIS_ANSWER}]`);
  await expect(receipt).toBeVisible();
  const closeResolved = receipt.locator(
    `[${CHAT_DATA_DIAGNOSIS_ANSWER_ACTION}]`
    + '[data-action="resolve-resolved"]',
  );
  await closeResolved.focus();
  await closeResolved.click();
  await expect(closeResolved).toHaveText('Saving…');
  await expect(closeResolved).toBeFocused();
  await expect(closeResolved).not.toHaveAttribute('disabled');
  await expect(closeResolved).toHaveAttribute('aria-disabled', 'true');
  await expect(closeResolved).toHaveAttribute('aria-busy', 'true');
  await expect(receipt.locator(
    `[${CHAT_DATA_DIAGNOSIS_ANSWER_ACTION}]`
    + '[data-action="resolve-still_uncertain"]',
  )).toHaveAttribute('aria-disabled', 'true');
  await closeResolved.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('chat.data_diagnosis.resolve'),
  )).toBe(1);
  await expect(receipt).toHaveAttribute('data-resolution', 'resolved');
  await expect(receipt).toHaveAttribute('tabindex', '-1');
  await expect(receipt).toHaveAttribute('role', 'status');
  await expect(receipt).toBeFocused();
});
