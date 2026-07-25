import { expect, test } from '@playwright/test';

/**
 * Path B — the WHOLE webclient app booted in a real Chromium off the
 * deterministic fakes (full-app-harness.ts), every IA route driven by hash.
 *
 * Why this exists: every surface dispatches INSIDE the paired `bootstrapWebclient`
 * (after the WS handshake), so a cold staging load with no paired server only ever
 * reaches the pair-form (staging-smoke.spec covers that). The REAL populated
 * end-to-end — a booted recued-server + the pair→WS handshake + seeded data — is
 * internal benchmarks. THIS spec is the repeatable,
 * server-free regression twin: it boots the same app the bootstrap dispatches
 * against the fakes the `webclient-bootstrap.test.ts` suite already proves boot the
 * full shell, then drives each route hash and asserts it MOUNTS + RENDERS in a real
 * browser without throwing.
 *
 * Scope, honestly: the fake transport answers the deterministic first-run
 * reads, empty recipe handoff, and one populated run → record verification
 * journey; other route rpcs remain pending, so those routes render their real
 * shell + chrome + loading placeholders. The broad populated pass remains
 * render.mjs's job. The route-root marker
 * (`data-recued-<route>-route`) is
 * stamped synchronously by every route the instant it mounts, before any rpc,
 * so it is the durable "this route mounted in a real browser" signal — the same
 * existence contract the unit suite asserts, here proven against real CSS +
 * layout + a `pageerror` gate.
 *
 * Prereq: `node e2e/harness/build-harness.mjs` (the npm script runs it first).
 */

const HARNESS_ORIGIN = 'http://127.0.0.1:4319';
const HARNESS_URL = `${HARNESS_ORIGIN}/full-app-harness.html`;
const ARTIFACTS = 'apps/webclient/e2e/.playwright-artifacts';

const SHELL_HOST = 'data-recued-webclient-shell';
const SHELL_CONTENT = 'data-recued-webclient-content';
const SHELL_TOPBAR = 'data-recued-webclient-topbar';
const DRAWER_TOGGLE = 'data-recued-webclient-drawer-toggle';
const DRAWER = 'data-recued-webclient-drawer';
const DRAWER_OPEN = 'data-recued-webclient-drawer-open';
const DRAWER_LINK = 'data-recued-webclient-drawer-link';
const CHAT_ACTIVATION = 'data-recued-chat-route-activation';
const CHAT_ACTIVATION_CARD = 'data-recued-chat-route-activation-card';
const CHAT_ACTIVATION_ACTION = 'data-recued-chat-route-activation-action';
const CHAT_INPUT = 'data-recued-chat-route-input';
const CHAT_SEND = 'data-recued-chat-route-send';
const CHAT_MESSAGE = 'data-recued-chat-route-message';
const CHAT_SESSION_ROW = 'data-recued-chat-route-session-row';
const CHAT_AI_UNAVAILABLE = 'data-recued-chat-route-ai-unavailable';
const CHAT_SOURCE_HANDOFF = 'data-recued-chat-source-handoff';
const CHAT_SOURCE_ACTION = 'data-recued-chat-source-action';
const CHAT_SOURCE_ANSWER = 'data-recued-chat-source-answer';
const CHAT_SOURCE_ANSWER_ACTION = 'data-recued-chat-source-answer-action';
const CHAT_SOURCE_ANSWER_RECEIPT = 'data-recued-chat-source-answer-receipt';
const CHAT_SOURCE_REFERENCES = 'data-recued-chat-source-references';
const CHAT_SOURCE_REFERENCES_TOGGLE =
  'data-recued-chat-source-references-toggle';
const CHAT_SOURCE_REFERENCE = 'data-recued-chat-source-reference';
const CHAT_SOURCE_REFERENCE_ID = 'data-recued-chat-source-reference-id';
const CHAT_SOURCE_REFERENCE_OPEN =
  'data-recued-chat-source-reference-open';
const CHAT_RETURN_TARGET = 'data-recued-chat-route-return-target';
const CHAT_FOLLOWUP_CONTEXT = 'data-recued-chat-followup-context';
const CHAT_FOLLOWUP_CONTEXT_CLEAR =
  'data-recued-chat-followup-context-clear';
const CHAT_PLAN_CARD = 'data-recued-chat-route-plan-card';
const CHAT_PLAN_APPROVE = 'data-recued-chat-route-plan-approve';
const CHAT_PLAN_CONTINUE = 'data-recued-chat-route-plan-continue';
const CHAT_PLAN_CONTEXT = 'data-recued-chat-route-plan-context';
const CHAT_DATA_DIAGNOSIS_ANSWER =
  'data-recued-chat-route-data-diagnosis-answer';
const CHAT_DATA_DIAGNOSIS_ANSWER_ACTION =
  'data-recued-chat-route-data-diagnosis-answer-action';
const CHAT_ANSWER_WAITING = 'data-recued-chat-answer-waiting';
const CHAT_SETUP = 'data-recued-ai-models-chat-setup';
const CHAT_SETUP_KEY = 'data-recued-ai-models-chat-setup-key';
const CHAT_SETUP_SUBMIT = 'data-recued-ai-models-chat-setup-submit';
const CONNECTIONS_ROUTE = 'data-recued-connections-route';
const CONNECTIONS_DESCRIPTION = 'data-recued-connections-route-description';
const CONNECTIONS_TABS = 'data-recued-connections-route-tabs';
const ACCOUNTS_EMPTY = 'data-accounts-empty';
const ACCOUNT_CONNECTION_SUCCESS = 'data-accounts-connection-success';
const OAUTH_APP_STATE = 'data-oauth-app-state';
const OAUTH_CRED_FIELD = 'data-oauth-cred-field';
const DATA_CHAT_RETURN = 'data-recued-data-route-chat-return';
const DATA_DETAIL_HEADING = 'data-recued-collection-detail-heading';
const DATA_VERIFICATION_ACTION =
  'data-recued-data-route-verification-action';
const LOGS_OUTCOME = 'data-recued-logs-outcome';
const LOGS_AFFECTED_ITEMS = 'data-recued-logs-affected-items';
const RUN_PALETTE = 'data-recued-run-palette';
const RUN_PALETTE_CLOSE = 'data-recued-run-palette-close';

// Every IA route + its synchronously-stamped route-root marker (the same markers
// webclient-bootstrap.test.ts asserts). Kitchen is reached via a deep link
// (`#kitchen/pack`, the pack builder the bare `#kitchen` canonicalizes into);
// the rest are their bare surface hash.
const ROUTES: ReadonlyArray<{ hash: string; route: string; marker: string }> = [
  { hash: '#chat', route: 'chat', marker: 'data-recued-chat-route' },
  { hash: '#data', route: 'data', marker: 'data-recued-data-route' },
  { hash: '#recipes', route: 'recipes', marker: 'data-recued-recipes-route' },
  { hash: '#packs', route: 'packs', marker: 'data-recued-packs-route' },
  { hash: '#automation', route: 'automation', marker: 'data-recued-automation-route' },
  { hash: '#connections', route: 'connections', marker: 'data-recued-connections-route' },
  { hash: '#contracts', route: 'contracts', marker: 'data-recued-contracts-route' },
  { hash: '#reception', route: 'reception', marker: 'data-recued-reception-route' },
  { hash: '#approvals', route: 'approvals', marker: 'data-recued-approvals-route' },
  { hash: '#logs', route: 'logs', marker: 'data-recued-logs-route' },
  { hash: '#settings', route: 'settings', marker: 'data-recued-settings-route' },
  { hash: '#kitchen/pack', route: 'kitchen', marker: 'data-recued-kitchen-route' },
];

const pageErrors: Error[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on('pageerror', (err) => pageErrors.push(err));
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => window.__app?.ready === true);
});
test.afterEach(() => {
  expect(
    pageErrors,
    `uncaught page errors: ${pageErrors.map((e) => e.message).join(' | ')}`,
  ).toHaveLength(0);
});

test('boots the full app + mounts the persistent shell on the chat home', async ({ page }) => {
  // The persistent shell owns the app root; the content slot + drawer are chrome.
  await expect(page.locator(`[${SHELL_HOST}]`)).toBeVisible();
  await expect(page.locator(`[${SHELL_CONTENT}]`)).toBeVisible();
  await expect(page.locator(`[${DRAWER_TOGGLE}]`)).toBeVisible();
  // Fixed default landing = the chat home (hashSource seeds `#chat`).
  expect(await page.evaluate(() => window.__app.activeRoute())).toBe('chat');
  await expect(page.locator('[data-recued-chat-route]')).toBeVisible();
});

test('the first-run Chat landing offers outcomes and seeds a prompt without sending', async ({ page }) => {
  const activation = page.locator(`[${CHAT_ACTIVATION}]`);
  await expect(activation).toBeVisible();
  await expect(activation.locator(`[${CHAT_ACTIVATION_CARD}]`)).toHaveCount(3);
  await expect(activation).toContainText('Ask Recued');
  await expect(activation).toContainText('Connect my work');
  await expect(activation).toContainText('Automate a task');

  await expect(
    activation.locator(`[${CHAT_ACTIVATION_ACTION}="connect"]`),
  ).toHaveAttribute('href', '#connections');
  await page.setViewportSize({ width: 390, height: 844 });
  await activation.locator(`[${CHAT_ACTIVATION_ACTION}="ask"]`).click();
  const input = page.locator(`[${CHAT_INPUT}]`);
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
  await expect(setup).toContainText('Connect a model to start chatting');
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

  await expect(page.locator(`[${CHAT_SETUP_SUBMIT}="new"]`)).toBeEnabled();
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

test('a reviewed write stays explicit from approval through the Chat handoff', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?chat=session`);
  await page.waitForFunction(() => window.__app?.ready === true);

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
  await expect(card).toContainText('Review required');
  await expect(card).toContainText('Send email');
  await expect(card).toContainText(
    'Approving gives Chat one-time permission for these exact details; '
    + 'it does not run the action.',
  );
  await expect(card.locator('.chat-plan-card-detail')).toHaveCount(3);
  await expect(card).toContainText('mary@example.com');
  await expect(card).toContainText('Quarterly planning follow-up');
  await expect(card.locator('details')).not.toHaveAttribute('open', '');
  const technicalSummary = await card
    .locator('.chat-plan-card-technical summary')
    .boundingBox();
  expect(technicalSummary?.height).toBeGreaterThanOrEqual(32);
  await expect(card).toContainText('Tool: mail.send · Tier 2');
  await expect(card.getByRole('button', { name: 'Approve once' })).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Don’t approve' }),
  ).toBeVisible();
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-plan-review-mobile.png`,
    fullPage: true,
  });

  await card.locator(`[${CHAT_PLAN_APPROVE}]`).click();
  await expect(card).toHaveAttribute('data-status', 'approved');
  await expect(card).toContainText('Approved once');
  await expect(card).toContainText(
    'Continue in Chat when you’re ready to ask Chat to carry it out.',
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
    'If the action changes, you’ll review it again.',
  );
  await expect(page.locator(`[${CHAT_SEND}]`)).toHaveText('Continue');
  await expect(card).toContainText(
    'A continuation is ready in the composer.',
  );
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-plan-continuation-mobile.png`,
    fullPage: true,
  });

  await page.locator(`[${CHAT_SEND}]`).click();
  await expect(context).toHaveCount(0);
  await expect(card.locator(`[${CHAT_PLAN_CONTINUE}]`)).toHaveCount(0);
  await expect(card).toContainText(
    'Continuation sent to Chat. If the action changes, Chat will '
    + 'ask for a new approval.',
  );
});

test('a safe-check closure keeps focus on its durable receipt', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?chat=session`);
  await page.waitForFunction(() => window.__app?.ready === true);
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
  await receipt
    .locator(
      `[${CHAT_DATA_DIAGNOSIS_ANSWER_ACTION}]`
      + '[data-action="resolve-resolved"]',
    )
    .click();
  await expect(receipt).toHaveAttribute('data-resolution', 'resolved');
  await expect(receipt).toHaveAttribute('tabindex', '-1');
  await expect(receipt).toHaveAttribute('role', 'status');
  await expect(receipt).toBeFocused();
});

test('an uncertain run lands on its exact record with readable dark-theme next steps', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${HARNESS_URL}?chat=session&journey=verification`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    window.__app.setHash(
      '#logs/run-verify/return/chat/session/chat_1/plan/'
      + 'plan_email_1/answer/msg_action',
    );
  });

  const outcome = page.locator(`[${LOGS_OUTCOME}]`);
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText('Outcome needs verification');
  await expect(outcome).toBeFocused();
  const openRun = page.getByRole('button', { name: 'Open run detail' });
  const openRunBox = await openRun.boundingBox();
  expect(openRunBox?.width).toBeGreaterThanOrEqual(32);
  expect(openRunBox?.height).toBeGreaterThanOrEqual(32);
  const detailLinkHeights = await page
    .locator('.logs-row-links a, .logs-detail-meta a')
    .evaluateAll((links) =>
      links.map((link) => link.getBoundingClientRect().height)
    );
  expect(detailLinkHeights.length).toBeGreaterThan(0);
  expect(Math.min(...detailLinkHeights)).toBeGreaterThanOrEqual(24);

  const affected = page.locator(`[${LOGS_AFFECTED_ITEMS}]`);
  const verify = affected.getByRole('link', {
    name: 'Verify before retrying',
  });
  await expect(verify).toBeVisible();
  await verify.click();

  const heading = page.locator(`[${DATA_DETAIL_HEADING}]`);
  await expect(heading).toBeVisible();
  await expect(heading).toHaveText('Customer review');
  await expect(heading).toHaveAttribute('tabindex', '-1');
  await expect(heading).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Customer review', level: 2 }),
  ).toBeVisible();

  const primary = page.locator(
    `[${DATA_VERIFICATION_ACTION}="reviewed"]`,
  );
  await expect(primary).toBeVisible();
  const contrast = await page.evaluate(
    ({ primarySelector }) => {
      const parse = (value: string): [number, number, number] => {
        const numbers = value.match(/[\d.]+/g)?.map(Number) ?? [];
        return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
      };
      const luminance = (value: string): number => {
        const [r, g, b] = parse(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (fg: string, bg: string): number => {
        const first = luminance(fg);
        const second = luminance(bg);
        return (Math.max(first, second) + 0.05)
          / (Math.min(first, second) + 0.05);
      };
      const backgroundFor = (node: Element): string => {
        let candidate: Element | null = node;
        while (candidate !== null) {
          const background = getComputedStyle(candidate).backgroundColor;
          const channels = background.match(/[\d.]+/g)?.map(Number) ?? [];
          if ((channels[3] ?? 1) > 0) return background;
          candidate = candidate.parentElement;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const measure = (): {
        value: number;
        label: number;
        action: number;
      } => {
        const value = document.querySelector(
          '.col-explorer-detail-field dd',
        );
        const label = document.querySelector(
          '.col-explorer-detail-field dt',
        );
        const action = document.querySelector(primarySelector);
        if (value === null || label === null || action === null) {
          throw new Error('verification contrast targets missing');
        }
        const actionStyle = getComputedStyle(action);
        return {
          value: ratio(getComputedStyle(value).color, backgroundFor(value)),
          label: ratio(getComputedStyle(label).color, backgroundFor(label)),
          action: ratio(actionStyle.color, actionStyle.backgroundColor),
        };
      };
      const dark = measure();
      document.documentElement.dataset.theme = 'light';
      const light = measure();
      document.documentElement.dataset.theme = 'dark';
      return {
        dark,
        light,
        pageWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      };
    },
    {
      primarySelector:
        `[${DATA_VERIFICATION_ACTION}="reviewed"]`,
    },
  );
  for (const theme of [contrast.light, contrast.dark]) {
    expect(theme.value).toBeGreaterThanOrEqual(4.5);
    expect(theme.label).toBeGreaterThanOrEqual(4.5);
    expect(theme.action).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast.pageWidth).toBeLessThanOrEqual(contrast.viewport);
  const rawSummary = page.locator('.col-explorer-detail-raw summary');
  expect((await rawSummary.boundingBox())?.height).toBeGreaterThanOrEqual(32);

  await primary.click();
  await expect(page).toHaveURL(
    /#chat\/session\/chat_1\/plan\/plan_email_1/,
  );
  await expect(page.locator('[data-recued-chat-route]')).toBeVisible();
});

test('the first-run recipe handoff traps focus and recovers an empty inventory', async ({ page }) => {
  const automate = page.locator(
    `[${CHAT_ACTIVATION_ACTION}="automate"]`,
  );
  await automate.click();

  const overlay = page.locator(`[${RUN_PALETTE}]`);
  const dialog = page.getByRole('dialog', { name: 'Run a recipe' });
  await expect(overlay).toBeVisible();
  await expect(dialog).toBeFocused();
  await expect(dialog).toContainText('No recipes are installed yet.');
  await expect(dialog.getByRole('combobox', { name: 'Recipe' })).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: /Browse starter packs/ }))
    .toHaveAttribute('href', '#packs');

  await page.keyboard.press('Tab');
  await expect(page.locator(`[${RUN_PALETTE_CLOSE}]`)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await overlay.evaluate((node) => node.contains(document.activeElement)))
    .toBe(true);

  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await expect(automate).toBeFocused();
});

test('the Connections landing explains the choices and starts with one clear action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#connections'));

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  await expect(route).toBeVisible();
  await expect(route.locator(`[${CONNECTIONS_DESCRIPTION}]`)).toHaveText(
    'Bring your mail, calendars, files, and everyday services into Recued.',
  );

  const tabs = route.locator(`[${CONNECTIONS_TABS}]`);
  await expect(tabs).toHaveAttribute('aria-label', 'Connection types');
  await expect(tabs.getByRole('link')).toHaveText([
    'Mail',
    'Calendar',
    'Files',
    'Apps & APIs',
    'Webhooks',
  ]);

  const empty = route.locator(`[${ACCOUNTS_EMPTY}]`);
  await expect(empty).toBeVisible();
  await expect(empty.getByRole('heading')).toHaveText('Connect your first mailbox');
  await expect(empty).toContainText('Gmail');
  await expect(empty).toContainText('Microsoft');
  await expect(empty).toContainText('IMAP / SMTP');
  const connect = empty.getByRole('button', { name: 'Connect mailbox' });
  await expect(connect).toBeVisible();

  const geometry = await route.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 0.5);
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport);
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-connections-first-run-mobile.png`,
    fullPage: true,
  });

  await connect.click();
  await expect(
    page.getByRole('heading', { name: 'Choose a mail provider', level: 2 }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Gmail/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Microsoft/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /IMAP \/ SMTP/ })).toBeVisible();

  await tabs.getByRole('link', { name: 'Calendar' }).click();
  await expect(page).toHaveURL(/#connections\/calendar$/);
  await expect(route.locator(`[${ACCOUNTS_EMPTY}]`)).toContainText(
    'Connect your first calendar',
  );
  await expect(
    route.getByRole('button', { name: 'Connect calendar' }),
  ).toBeVisible();

  await route.getByRole('link', { name: 'Files' }).click();
  await expect(page).toHaveURL(/#connections\/file$/);
  await expect(route.locator(`[${ACCOUNTS_EMPTY}]`)).toContainText(
    'Add your first file source',
  );
  await expect(
    route.getByRole('button', { name: 'Add file source' }),
  ).toBeVisible();
});

test('configured Google and Microsoft sign-in stay out of the way of connecting', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?oauth=ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#connections'));

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  await route.getByRole('button', { name: 'Connect mailbox' }).click();
  await route.getByRole('button', { name: /^Gmail/ }).click();

  const ready = route.locator(`[${OAUTH_APP_STATE}="ready"]`);
  await expect(ready).toBeVisible();
  await expect(ready).toContainText('Google sign-in is ready');
  await expect(ready).toContainText('No app credentials are needed here');
  const manage = ready.locator('details.accounts-oauth-manage');
  await expect(manage).not.toHaveAttribute('open', '');
  await expect(
    ready.locator(`[${OAUTH_CRED_FIELD}="client_id"]`),
  ).not.toBeVisible();

  const connect = route.getByRole('button', { name: 'Connect Gmail' });
  await expect(connect).toBeDisabled();
  await route.getByRole('textbox', { name: 'Mailbox name' }).fill('work');
  await expect(connect).toBeEnabled();

  const geometry = await route.evaluate((node) => ({
    pageWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    right: node.getBoundingClientRect().right,
  }));
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 0.5);
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-connections-google-ready-mobile.png`,
    fullPage: true,
  });

  await route.getByRole('link', { name: 'Calendar' }).click();
  await route.getByRole('button', { name: 'Connect calendar' }).click();
  await route.getByRole('button', { name: /^Microsoft/ }).click();
  const microsoftReady = route.locator(`[${OAUTH_APP_STATE}="ready"]`);
  await expect(microsoftReady).toContainText('Microsoft sign-in is ready');
  await expect(
    microsoftReady.locator(`[${OAUTH_CRED_FIELD}="client_id"]`),
  ).not.toBeVisible();
  const connectMicrosoft = route.getByRole('button', { name: 'Connect Microsoft' });
  await expect(connectMicrosoft).toBeDisabled();
  await route.getByRole('textbox', { name: 'Calendar name' }).fill('work');
  await expect(connectMicrosoft).toBeEnabled();
});

test('a connected mailbox hands its first useful question into Chat', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?connection=first-sync`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#connections'));

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  await route.getByRole('button', { name: 'Connect mailbox' }).click();
  await route.getByRole('button', { name: /^Gmail/ }).click();
  await route.getByRole('textbox', { name: 'Mailbox name' }).fill('work');

  // Keep the provider hop deterministic. The popup driver + callback relay
  // have their own unit coverage; this browser pass drives the same MessageEvent
  // the same-origin loopback relay posts after consent.
  await context.route('https://accounts.google.com/**', async (request) => {
    await request.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Google consent test double</title>',
    });
  });
  const popupPromise = page.waitForEvent('popup');
  await route.getByRole('button', { name: 'Connect Gmail' }).click();
  const popup = await popupPromise;
  await popup.waitForURL(/accounts\.google\.com/);
  const oauthState = new URL(popup.url()).searchParams.get('state');
  expect(oauthState).toMatch(/^frelay_/);
  await page.evaluate((state) => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { kind: 'recued:oauth-code', state, code: 'BROWSER-AUTH-CODE' },
    }));
  }, oauthState);

  const success = route.locator(`[${ACCOUNT_CONNECTION_SUCCESS}]`);
  await expect(success).toBeVisible();
  await expect(success).toHaveAttribute('data-sync-state', 'pending');
  await expect(success).toBeFocused();
  await expect(success.getByRole('heading', { name: 'Gmail connected' })).toBeVisible();
  await expect(success).toContainText('person@example.com');
  await expect(success).toContainText('First sync pending');
  await expect(success).toContainText('syncing continues on your server');
  await expect(success.getByRole('button', { name: 'Continue to Chat' })).toBeVisible();
  await expect(success.getByRole('button', { name: 'Connect a calendar' })).toBeVisible();

  const geometry = await success.evaluate((node) => ({
    left: node.getBoundingClientRect().left,
    right: node.getBoundingClientRect().right,
    viewport: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 0.5);
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport);
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-connections-first-sync-mobile.png`,
    fullPage: true,
  });
  await success.getByRole('button', { name: 'Continue to Chat' }).click();
  await expect(page).toHaveURL(/#chat\/source\/mail\/gmail\/work$/);

  const handoff = page.locator(`[${CHAT_SOURCE_HANDOFF}]`);
  await expect(handoff).toBeVisible();
  await expect(handoff).toHaveAttribute('data-state', 'pending');
  await expect(handoff).toBeFocused();
  await expect(handoff.getByRole('heading', { name: 'Gmail is connected' })).toBeVisible();
  await expect(handoff).toContainText('person@example.com');
  await expect(handoff).toContainText('prepare a useful first question');
  await expect(page.locator(`[${CHAT_ACTIVATION}]`)).toHaveCount(0);
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue('');
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-connected-source-pending-mobile.png`,
    fullPage: true,
  });

  // Chat owns the bounded continuation check after Connections unmounts. It
  // must not overwrite or send anything while the first sync is still pending.
  const pendingScrollY = await page.evaluate(() => window.scrollY);
  await expect(handoff).toHaveAttribute('data-state', 'ready');
  await expect(handoff).toBeFocused();
  await expect(handoff.getByRole('heading', { name: 'Gmail is ready for Chat' })).toBeVisible();
  await expect(handoff).toContainText('A useful first question is ready below');
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue(
    'Using my work mailbox, summarize what needs my attention and suggest the next three actions.',
  );
  await expect(page.locator(`[${CHAT_SESSION_ROW}]`)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(pendingScrollY);

  await handoff.locator(`[${CHAT_SOURCE_ACTION}="primary"]`).click();
  await expect(page.locator(`[${CHAT_INPUT}]`)).toBeFocused();
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-connected-source-ready-mobile.png`,
    fullPage: true,
  });

  await handoff.getByRole('button', {
    name: 'Use Chat without this account',
  }).click();
  await expect(page).toHaveURL(/#chat$/);
  await expect(handoff).toHaveCount(0);
  await expect(page.locator(`[${CHAT_ACTIVATION}]`)).toHaveCount(0);
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue('');
});

test('a connected-source answer stays source-aware through its first follow-up', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?connection=source-answer`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    window.__app.setHash('#chat/source/mail/gmail/work');
  });

  const question =
    'Using my work mailbox, summarize what needs my attention and suggest the next three actions.';
  const input = page.locator(`[${CHAT_INPUT}]`);
  const handoff = page.locator(`[${CHAT_SOURCE_HANDOFF}]`);
  await expect(handoff).toHaveAttribute('data-state', 'ready');
  await expect(input).toHaveValue(question);
  await page.locator(`[${CHAT_SEND}]`).click();

  await expect(page).toHaveURL(/#chat$/);
  await expect(handoff).toHaveCount(0);
  const answer = page.locator(`[${CHAT_SOURCE_ANSWER}]`);
  await expect(answer).toHaveAttribute('data-state', 'preparing');
  await expect(answer).toContainText('Gmail · person@example.com');
  await expect(answer.locator(`[${CHAT_SOURCE_ANSWER_RECEIPT}]`))
    .toHaveText('Checking activity');
  await expect(page.locator(`[${CHAT_ANSWER_WAITING}]`))
    .toHaveText('Preparing your answer…');
  await expect(
    page.locator(`[${CHAT_MESSAGE}][data-role="user"]`),
  ).toContainText(question);

  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.tool_call_started',
        session_id: 'chat_source_1',
        turn_id: 'turn_source_1',
        tool_name: 'mail.search',
        tier: 1,
        args: { query: 'needs attention' },
        cursor: 1,
      },
    });
  });
  await expect(answer).toHaveAttribute('data-state', 'searching');
  await expect(answer.locator(`[${CHAT_SOURCE_ANSWER_RECEIPT}]`))
    .toHaveText('Searching mail');
  await expect(page.locator(`[${CHAT_ANSWER_WAITING}]`))
    .toHaveText('Searching connected mail…');
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-source-answer-searching-mobile.png`,
    fullPage: true,
  });

  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.tool_call_completed',
        session_id: 'chat_source_1',
        turn_id: 'turn_source_1',
        tool_name: 'mail.search',
        tier: 1,
        status: 'ok',
        result_ref: 'chat_source_1:turn_source_1:mail.search',
        cursor: 2,
      },
    });
  });
  await expect(answer).toHaveAttribute('data-state', 'reviewing');
  await expect(page.locator(`[${CHAT_ANSWER_WAITING}]`))
    .toHaveText('Reviewing the mail search…');

  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.token_streamed',
        session_id: 'chat_source_1',
        turn_id: 'turn_source_1',
        delta: 'Three messages need your attention.',
        cursor: 3,
      },
    });
  });
  await expect(
    page.locator(`[${CHAT_MESSAGE}][data-role="assistant"]`),
  ).toContainText('Three messages need your attention.');

  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.message_complete',
        session_id: 'chat_source_1',
        turn_id: 'turn_source_1',
        final: {
          id: 'msg_source_answer',
          session_id: 'chat_source_1',
          role: 'assistant',
          content:
            'Three messages need your attention. Start with the most time-sensitive reply.',
          target_server: 'self',
          picker_at_send: {
            display_name: 'This server',
            signature: {
              server_kind: 'recued',
              version: 'test',
              instance_id: 'server-source-answer',
            },
          },
          model_used: {
            provider: 'openai',
            model_id: 'gpt-4.1-mini',
          },
          tool_calls: [{
            tool_name: 'mail.search',
            tier: 1,
            args: { query: 'needs attention' },
            status: 'ok',
            result_ref: 'chat_source_1:turn_source_1:mail.search',
            started_at: 1_700_000_000_010,
            completed_at: 1_700_000_000_020,
          }],
          provenance: [
            {
              source: 'local',
              collection_platform: 'mail',
              collection_slug: 'work',
              record_id: 'mail-1',
              label: 'Quarterly planning',
            },
            {
              source: 'local',
              collection_platform: 'mail',
              collection_slug: 'work',
              record_id:
                'mail:message:01J4X9Z8V7W6T5S4R3Q2P1N0M9L8K7J6',
              label: 'Launch readiness',
            },
          ],
          contributor: 'model',
          ts: 1_700_000_000_030,
        },
        cursor: 4,
      },
    });
  });

  await expect(answer).toHaveAttribute('data-state', 'search_complete');
  await expect(answer.locator(`[${CHAT_SOURCE_ANSWER_RECEIPT}]`))
    .toHaveText('Mail search completed');
  await expect(answer).toContainText(
    'The receipt does not show which records, if any, informed the answer.',
  );
  const references = answer.locator(`[${CHAT_SOURCE_REFERENCES}]`);
  const referencesToggle = references.locator(
    `[${CHAT_SOURCE_REFERENCES_TOGGLE}]`,
  );
  await expect(referencesToggle).toContainText('2 recorded references');
  await expect(referencesToggle).toContainText(
    'Source and exact record IDs',
  );
  await expect(referencesToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(references.locator(`[${CHAT_SOURCE_REFERENCE}]`)).toHaveCount(0);
  await referencesToggle.click();
  await expect(referencesToggle).toBeFocused();
  await expect(referencesToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(references).toContainText(
    'They are not yet linked to individual sentences.',
  );
  await expect(references.locator(`[${CHAT_SOURCE_REFERENCE}]`)).toHaveCount(2);
  await expect(references.locator(`[${CHAT_SOURCE_REFERENCE_ID}]`))
    .toHaveText([
      'mail-1',
      'mail:message:01J4X9Z8V7W6T5S4R3Q2P1N0M9L8K7J6',
    ]);
  await expect(references).toContainText('Quarterly planning');
  await expect(references).toContainText('Launch readiness');
  const recordLinks = references.locator(`[${CHAT_SOURCE_REFERENCE_OPEN}]`);
  await expect(recordLinks).toHaveCount(2);
  await expect(recordLinks.nth(0)).toHaveAttribute(
    'href',
    '#data/mail/record/work/mail-1/return/chat/chat_source_1/msg_source_answer',
  );
  await expect(recordLinks.nth(1)).toHaveAttribute(
    'href',
    '#data/mail/record/work/mail%3Amessage%3A01J4X9Z8V7W6T5S4R3Q2P1N0M9L8K7J6/return/chat/chat_source_1/msg_source_answer',
  );
  await expect(references.getByRole('link', { name: 'Browse mail in Data' }))
    .toHaveAttribute('href', '#data/mail');
  await expect(answer).toContainText(
    'Choose a next step to review it in the composer. '
    + 'These shortcuts do not send email or change your data.',
  );
  await expect(page.locator(`[${CHAT_ANSWER_WAITING}]`)).toHaveCount(0);
  await expect(
    page.locator(`[${CHAT_MESSAGE}][data-role="assistant"]`),
  ).toContainText('Start with the most time-sensitive reply.');
  const readingOrder = await page.locator(
    `[${CHAT_MESSAGE}][data-role="assistant"], [${CHAT_SOURCE_ANSWER}]`,
  ).evaluateAll(
    (nodes, sourceAnswerAttr) => nodes.map((node) =>
      node.getAttribute(sourceAnswerAttr) !== null ? 'source-check' : 'answer'),
    CHAT_SOURCE_ANSWER,
  );
  expect(readingOrder).toEqual(['answer', 'source-check']);
  await expect(answer.locator(`[${CHAT_SOURCE_ANSWER_ACTION}="draft"]`))
    .toHaveText(['Draft the replies', 'Make an action list']);
  await expect(answer.locator(`[${CHAT_SOURCE_ANSWER_ACTION}="connection"]`))
    .toHaveText('View mailbox');

  const geometry = await answer.evaluate((node) => ({
    left: node.getBoundingClientRect().left,
    right: node.getBoundingClientRect().right,
    viewport: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 0.5);
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport);
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-source-references-mobile.png`,
    fullPage: true,
  });
  await referencesToggle.click();
  await expect(referencesToggle).toBeFocused();
  await expect(referencesToggle).toHaveAttribute('aria-expanded', 'false');

  await answer.getByRole('button', { name: 'Draft the replies' }).click();
  await expect(input).toHaveValue(
    'Search my connected mail again for the messages that need my response, '
    + 'then draft concise replies. Do not send anything.',
  );
  await expect(input).toBeFocused();
  let followupContext = page.locator(`[${CHAT_FOLLOWUP_CONTEXT}]`);
  await expect(followupContext).toHaveAttribute(
    CHAT_FOLLOWUP_CONTEXT,
    'refresh',
  );
  await expect(followupContext).toContainText('Review first');
  await expect(followupContext).toContainText(
    'Reply drafts · Gmail · person@example.com',
  );
  await expect(followupContext).toContainText('Gmail · person@example.com');
  await expect(followupContext).toContainText('Requests a new mail search');
  await expect(followupContext).toContainText(
    'If you ask it to send email, you’ll review and approve that separately.',
  );
  await expect(input).toHaveAttribute(
    'placeholder',
    'Review or edit this request...',
  );
  await expect(page.locator(`[${CHAT_SEND}]`)).toHaveText('Ask Chat');
  const followupDescriptionId = await input.getAttribute('aria-describedby');
  if (followupDescriptionId === null) {
    throw new Error('source-aware follow-up did not describe the composer');
  }
  await expect(page.locator(`#${followupDescriptionId}`)).toContainText(
    'Requests a new mail search',
  );
  await expect(
    followupContext.locator(`[${CHAT_FOLLOWUP_CONTEXT_CLEAR}]`),
  ).toHaveText('Clear suggestion');
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-source-followup-draft-mobile.png`,
    fullPage: true,
  });
  await expect(
    page.locator(`[${CHAT_MESSAGE}][data-role="user"]`),
  ).toHaveCount(1);

  await followupContext.locator(`[${CHAT_FOLLOWUP_CONTEXT_CLEAR}]`).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(followupContext).toHaveCount(0);
  await expect(input).toHaveAttribute('placeholder', 'Ask Recued...');
  await expect(page.locator(`[${CHAT_SEND}]`)).toHaveText('Send');

  await answer.getByRole('button', { name: 'Make an action list' }).click();
  await expect(input).toHaveValue(
    'Using the previous mailbox summary, turn the action items into '
    + 'a prioritized task list.',
  );
  followupContext = page.locator(`[${CHAT_FOLLOWUP_CONTEXT}]`);
  await expect(followupContext).toHaveAttribute(
    CHAT_FOLLOWUP_CONTEXT,
    'context',
  );
  await expect(followupContext).toContainText(
    'Continues from the previous answer · no new search requested',
  );
  await expect(followupContext).toContainText(
    'Prioritized action list · Gmail · person@example.com',
  );
  await expect(followupContext).toContainText(
    'If you ask it to create tasks, you’ll review and approve that separately.',
  );
  await expect(page.locator(`[${CHAT_SEND}]`)).toHaveText('Ask Chat');
  await page.locator(`[${CHAT_SEND}]`).click();

  const sourceAnswers = page.locator(`[${CHAT_SOURCE_ANSWER}]`);
  await expect(sourceAnswers).toHaveCount(2);
  await expect(sourceAnswers.nth(0)).toHaveAttribute(
    'data-state',
    'search_complete',
  );
  await expect(sourceAnswers.nth(1)).toHaveAttribute(
    'data-state',
    'continuing',
  );
  await expect(sourceAnswers.nth(1)).toContainText(
    'Prioritized action list · Gmail · person@example.com',
  );
  await expect(page.locator(`[${CHAT_ANSWER_WAITING}]`))
    .toHaveText('Continuing from the previous answer…');
  await expect(followupContext).toHaveCount(0);
  await expect(
    page.locator(`[${CHAT_MESSAGE}][data-role="user"]`),
  ).toHaveCount(2);

  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.token_streamed',
        session_id: 'chat_source_1',
        turn_id: 'turn_source_2',
        delta: '1. Reply to the launch owner.',
        cursor: 5,
      },
    });
  });
  await expect(
    page.locator(`[${CHAT_MESSAGE}][data-role="assistant"]`).last(),
  ).toContainText('Reply to the launch owner.');

  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.message_complete',
        session_id: 'chat_source_1',
        turn_id: 'turn_source_2',
        final: {
          id: 'msg_source_followup',
          session_id: 'chat_source_1',
          role: 'assistant',
          content:
            '1. Reply to the launch owner. 2. Confirm the review date.',
          target_server: 'self',
          picker_at_send: {
            display_name: 'This server',
            signature: {
              server_kind: 'recued',
              version: 'test',
              instance_id: 'server-source-answer',
            },
          },
          model_used: {
            provider: 'openai',
            model_id: 'gpt-4.1-mini',
          },
          tool_calls: [],
          contributor: 'model',
          ts: 1_700_000_000_040,
        },
        cursor: 6,
      },
    });
  });

  await expect(sourceAnswers.nth(1)).toHaveAttribute(
    'data-state',
    'context_only',
  );
  await expect(
    sourceAnswers.nth(1).locator(`[${CHAT_SOURCE_ANSWER_RECEIPT}]`),
  ).toHaveText('No new search');
  await expect(sourceAnswers.nth(1)).toContainText(
    'No new mail search was recorded.',
  );
  await expect(
    sourceAnswers.nth(0).locator(`[${CHAT_SOURCE_ANSWER_ACTION}]`),
  ).toHaveCount(0);
  await expect(
    sourceAnswers.nth(1).locator(`[${CHAT_SOURCE_ANSWER_ACTION}="draft"]`),
  ).toHaveText(['Draft the replies']);
  await expect(page.locator(`[${CHAT_ANSWER_WAITING}]`)).toHaveCount(0);
  const followupGeometry = await sourceAnswers.nth(1).evaluate((node) => ({
    left: node.getBoundingClientRect().left,
    right: node.getBoundingClientRect().right,
    viewport: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(followupGeometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(followupGeometry.right).toBeLessThanOrEqual(
    followupGeometry.viewport + 0.5,
  );
  expect(followupGeometry.pageWidth).toBeLessThanOrEqual(
    followupGeometry.viewport,
  );
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-source-followup-context-mobile.png`,
    fullPage: true,
  });

  const firstAnswerReferences = sourceAnswers.nth(0).locator(
    `[${CHAT_SOURCE_REFERENCES}]`,
  );
  await firstAnswerReferences.locator(
    `[${CHAT_SOURCE_REFERENCES_TOGGLE}]`,
  ).click();
  await firstAnswerReferences.getByRole('link', {
    name: 'Open Quarterly planning in Data',
  }).click();

  await expect(page).toHaveURL(
    /#data\/mail\/record\/work\/mail-1\/return\/chat\/chat_source_1\/msg_source_answer$/,
  );
  const dataRoute = page.locator('[data-recued-data-route]');
  await expect(dataRoute).toContainText('Quarterly planning');
  const chatReturn = dataRoute.locator(`[${DATA_CHAT_RETURN}]`);
  await expect(chatReturn).toContainText(
    'You came here from a cited Chat answer.',
  );
  await expect(
    chatReturn.getByRole('link', { name: 'Back to cited answer' }),
  ).toHaveAttribute(
    'href',
    '#chat/session/chat_source_1/answer/msg_source_answer',
  );
  const dataGeometry = await dataRoute.evaluate((node) => ({
    right: node.getBoundingClientRect().right,
    viewport: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(dataGeometry.right).toBeLessThanOrEqual(dataGeometry.viewport + 0.5);
  expect(dataGeometry.pageWidth).toBeLessThanOrEqual(dataGeometry.viewport);

  // The Chat entry was upgraded to the exact answer before navigation, so the
  // browser's own Back control is useful rather than returning to bare Chat.
  await page.goBack();
  await expect(page).toHaveURL(
    /#chat\/session\/chat_source_1\/answer\/msg_source_answer$/,
  );
  const citedAnswer = page.locator(
    `[${CHAT_MESSAGE}="msg_source_answer"][${CHAT_RETURN_TARGET}]`,
  );
  await expect(citedAnswer).toBeVisible();
  await expect(citedAnswer).toBeFocused();
  await expect(citedAnswer).toContainText(
    'Three messages need your attention.',
  );
  await expect(
    citedAnswer.locator(`[${CHAT_SOURCE_REFERENCES_TOGGLE}]`),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(
    citedAnswer.getByRole('link', {
      name: 'Open Quarterly planning in Data',
    }),
  ).toHaveAttribute(
    'href',
    '#data/mail/record/work/mail-1/return/chat/chat_source_1/msg_source_answer',
  );

  // The in-page return affordance lands on the same exact answer too.
  await citedAnswer.getByRole('link', {
    name: 'Open Quarterly planning in Data',
  }).click();
  await expect(page).toHaveURL(
    /#data\/mail\/record\/work\/mail-1\/return\/chat\/chat_source_1\/msg_source_answer$/,
  );
  await page.locator(`[${DATA_CHAT_RETURN}]`).getByRole('link', {
    name: 'Back to cited answer',
  }).click();
  await expect(page).toHaveURL(
    /#chat\/session\/chat_source_1\/answer\/msg_source_answer$/,
  );
  await expect(citedAnswer).toBeVisible();
});

test('missing OAuth configuration becomes a guided Gmail and Microsoft setup', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#connections'));

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  await route.getByRole('button', { name: 'Connect mailbox' }).click();
  await route.getByRole('button', { name: /^Gmail/ }).click();

  const googleSetup = route.locator(`[${OAUTH_APP_STATE}="setup"]`);
  await expect(googleSetup).toBeVisible();
  await expect(googleSetup).toContainText('One-time server setup');
  await expect(googleSetup).toContainText('Set up Google sign-in');
  await expect(googleSetup.locator('details.accounts-oauth-guide'))
    .toHaveAttribute('open', '');
  await expect(googleSetup.getByRole('link', { name: /Open Google Cloud Console/ }))
    .toHaveAttribute('href', 'https://console.cloud.google.com/apis/credentials');
  await expect(
    googleSetup.getByRole('button', { name: 'Copy authorized redirect URI' }),
  ).toBeVisible();

  const saveAndConnect = route.getByRole('button', {
    name: 'Save setup & connect Gmail',
  });
  await expect(saveAndConnect).toBeDisabled();
  const setupGeometry = await route.evaluate((node) => ({
    pageWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    right: node.getBoundingClientRect().right,
  }));
  expect(setupGeometry.pageWidth).toBeLessThanOrEqual(setupGeometry.viewport);
  expect(setupGeometry.right).toBeLessThanOrEqual(setupGeometry.viewport + 0.5);
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-connections-google-setup-mobile.png`,
    fullPage: true,
  });

  await route.getByRole('textbox', { name: 'Mailbox name' }).fill('work');
  await route.locator(`[${OAUTH_CRED_FIELD}="client_id"]`).fill('GOOGLE-CID');
  await route.locator(`[${OAUTH_CRED_FIELD}="client_secret"]`).fill('GOOGLE-SECRET');
  await expect(saveAndConnect).toBeEnabled();

  await route.getByRole('link', { name: 'Calendar' }).click();
  await route.getByRole('button', { name: 'Connect calendar' }).click();
  await route.getByRole('button', { name: /^Microsoft/ }).click();
  const microsoftSetup = route.locator(`[${OAUTH_APP_STATE}="setup"]`);
  await expect(microsoftSetup).toContainText('Set up Microsoft sign-in');
  await expect(microsoftSetup.getByRole('link', { name: /Open Microsoft Entra/ }))
    .toHaveAttribute('href', 'https://entra.microsoft.com/');
  await expect(microsoftSetup.locator('.accounts-oauth-redirect'))
    .not.toContainText('recued_relay');
  await expect(route.getByRole('button', {
    name: 'Save setup & connect Microsoft',
  })).toBeDisabled();
});

for (const { hash, route, marker } of ROUTES) {
  test(`route ${hash} mounts + renders in a real browser`, async ({ page }) => {
    await page.evaluate((h) => window.__app.setHash(h), hash);
    // The route-root marker appears the instant the route mounts (pre-rpc);
    // toBeVisible proves it rendered into the live shell with real layout.
    await expect(page.locator(`[${marker}]`)).toBeVisible();
    // The bootstrap's tracked active route matches what mounted.
    expect(await page.evaluate(() => window.__app.activeRoute())).toBe(route);
    // The persistent shell survived the content swap (chrome is not re-mounted).
    await expect(page.locator(`[${SHELL_HOST}]`)).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS}/full-app-${route}.png`, fullPage: false });
  });
}

test('the §D.L2 drawer opens via the ☰ toggle and a nav link drives the route', async ({ page }) => {
  const host = page.locator(`[${SHELL_HOST}]`);
  const openHost = page.locator(`[${SHELL_HOST}][${DRAWER_OPEN}]`);

  // Drawer defaults closed.
  await expect(openHost).toHaveCount(0);

  // ☰ opens it (the host carries the open-state attr the CSS slide-in keys off).
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await expect(openHost).toHaveCount(1);

  // A drawer nav link drives the route (and closes the drawer on navigate).
  await page.locator(`[${DRAWER_LINK}="data"]`).click();
  await expect(page.locator('[data-recued-data-route]')).toBeVisible();
  expect(await page.evaluate(() => window.__app.activeRoute())).toBe('data');
  await expect(host).toBeVisible();
});

test('the mobile shell stays within the viewport after a live heartbeat', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_heartbeat',
      payload: {
        server_id: 'sha256:mobile-layout',
        last_seen_at: Date.now(),
        lifecycle_state: 'running',
        uptime_s: 43_200,
      },
    });
  });

  const layout = await page.evaluate(({ topbarAttr, contentAttr }) => {
    const topbar = document.querySelector(`[${topbarAttr}]`)!.getBoundingClientRect();
    const content = document.querySelector(`[${contentAttr}]`)!.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      topbarLeft: topbar.left,
      topbarRight: topbar.right,
      contentLeft: content.left,
      contentRight: content.right,
    };
  }, { topbarAttr: SHELL_TOPBAR, contentAttr: SHELL_CONTENT });
  expect(layout.topbarLeft).toBeGreaterThanOrEqual(-0.5);
  expect(layout.contentLeft).toBeGreaterThanOrEqual(-0.5);
  expect(layout.topbarRight).toBeLessThanOrEqual(layout.viewport + 0.5);
  expect(layout.contentRight).toBeLessThanOrEqual(layout.viewport + 0.5);
});

test('the open navigation drawer contains keyboard focus and inerts the page', async ({ page }) => {
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await expect(page.locator(`[${SHELL_HOST}][${DRAWER_OPEN}]`)).toHaveCount(1);
  await expect(page.locator(`[${SHELL_TOPBAR}]`)).toHaveAttribute('inert', '');
  expect(await page.evaluate((contentAttr) =>
    document.querySelector(`[${contentAttr}]`)?.parentElement?.hasAttribute('inert'),
  SHELL_CONTENT)).toBe(true);

  for (let step = 0; step < 20; step += 1) {
    expect(await page.evaluate((drawerAttr) => {
      const drawer = document.querySelector(`[${drawerAttr}]`);
      return drawer?.contains(document.activeElement) === true;
    }, DRAWER)).toBe(true);
    await page.keyboard.press('Tab');
  }

  await page.keyboard.press('Escape');
  await expect(page.locator(`[${SHELL_HOST}][${DRAWER_OPEN}]`)).toHaveCount(0);
  await expect(page.locator(`[${SHELL_TOPBAR}]`)).not.toHaveAttribute('inert', '');
  await expect(page.locator(`[${DRAWER_TOGGLE}]`)).toBeFocused();
});
