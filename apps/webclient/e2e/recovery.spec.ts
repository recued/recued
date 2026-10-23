import { expect, test } from '@playwright/test';
import { HARNESS_SERVER_PUBLIC_KEY } from './harness/server-identity.js';
import { openChatHistory } from './helpers/chat-history.js';
import {
  CHAT_INPUT, CHAT_SESSION_ROW, CONNECTION_BANNER,
  CONNECTIONS_ROUTE, HARNESS_URL, SHELL_CONTENT, SHELL_HOST,
  installFullAppHooks,
} from './helpers/full-app.js';

/** Pairing and recovery journeys against the deterministic full-app harness. */
const STARTUP_RECOVERY_RETURN_RECEIPT_COPY =
  'Recued started up again. Your sign-in is still saved, and your page is ready.';
const STARTUP_RECOVERY_DRAFT_RETURN_RECEIPT_COPY =
  'Recued started up again. Your sign-in is still saved, and the Chat message you had not sent is ready.';
const STARTUP_RELOAD_RECOVERY_SESSION_KEY =
  'recued.webclient.startup-reload-recovery.v1';
const RECOVERY_REENTRY_SESSION_KEY =
  'recued.webclient.recovery-reentry.v1';
const PAIR_REAUTH_NOTICE = 'data-recued-pair-code-input-reauth-notice';
const PAIR_RECOVERY_HELP = 'data-recued-pair-code-input-recovery-help';
const PAIR_RECOVERY_CORRECTION =
  'data-recued-pair-code-input-recovery-correction';
const PAIR_RECOVERY_TRIAGE =
  'data-recued-pair-code-input-recovery-triage';
const PAIR_RECOVERY_STOP =
  'data-recued-pair-code-input-recovery-stop';
const PAIR_RECOVERY_STOP_REENTRY =
  'data-recued-pair-code-input-recovery-stop-reentry';
const PAIR_RECOVERY_RESUME_NOTICE =
  'data-recued-pair-code-input-recovery-resume-notice';
const PAIR_REPLACEMENT_REVIEW =
  'data-recued-pair-code-input-replacement-review';
const PAIR_REPLACEMENT_CONFIRMED =
  'data-recued-pair-code-input-replacement-confirmed';
const PAIR_RECOVERY_DIAGNOSTIC =
  'data-recued-pair-code-input-recovery-diagnostic';
const PAIR_RECOVERY_DIAGNOSTIC_SUMMARY =
  'data-recued-pair-code-input-recovery-diagnostic-summary';
const PAIR_SECURE_RESUME_NOTICE =
  'data-recued-pair-code-input-secure-resume-notice';
const PAIR_INTERRUPTED_NOTICE =
  'data-recued-pair-code-input-interrupted-notice';
const PAIR_TAKEOVER_READY =
  'data-recued-pair-code-input-takeover-ready';
const PAIR_TAKEOVER_OWNER =
  'data-recued-pair-code-input-takeover-owner';
const PAIR_SUCCESSION = 'data-recued-pair-code-input-succession';
const PAIR_RECOVERY_OWNER =
  'data-recued-pair-code-input-recovery-owner';
const PAIR_RECOVERY_OWNER_ELSEWHERE =
  'data-recued-pair-code-input-recovery-owner-elsewhere';
const PAIR_RECOVERY_SUCCESSOR =
  'data-recued-pair-code-input-recovery-successor';
const PAIR_RECOVERY_SUCCESSOR_ELSEWHERE =
  'data-recued-pair-code-input-recovery-successor-elsewhere';
const POST_PAIR_STARTUP_RECOVERY =
  'data-recued-post-pair-startup-recovery';
const POST_PAIR_STARTUP_RECOVERY_ACTION =
  'data-recued-post-pair-startup-recovery-action';
const STARTUP_FAILURE_TRIAGE = 'data-recued-startup-failure-triage';
const STARTUP_FAILURE_TRIAGE_ACTION =
  'data-recued-startup-failure-triage-action';
const STARTUP_FAILURE_TRIAGE_RELOAD =
  'data-recued-startup-failure-triage-reload';
const STARTUP_FAILURE_TRIAGE_STATUS =
  'data-recued-startup-failure-triage-status';
const STARTUP_FAILURE_DIAGNOSTIC_ACTION =
  'data-recued-startup-failure-diagnostic-action';
const STARTUP_FAILURE_DIAGNOSTIC =
  'data-recued-startup-failure-diagnostic';
const STARTUP_FAILURE_DIAGNOSTIC_COPY =
  'data-recued-startup-failure-diagnostic-copy';
const STARTUP_FAILURE_DIAGNOSTIC_SUMMARY =
  'data-recued-startup-failure-diagnostic-summary';
const STARTUP_FAILURE_DIAGNOSTIC_STATUS =
  'data-recued-startup-failure-diagnostic-status';
const COLD_START_CREDENTIAL_REPAIR =
  'data-recued-cold-start-credential-repair';
const COLD_START_CREDENTIAL_REPAIR_ACTION =
  'data-recued-cold-start-credential-repair-action';
const COLD_START_CREDENTIAL_RELOAD_ACTION =
  'data-recued-cold-start-credential-reload-action';
const PERSISTENT_STORAGE_RECOVERY =
  'data-recued-persistent-storage-recovery';
const PERSISTENT_STORAGE_RETRY =
  'data-recued-persistent-storage-retry';
const PERSISTENT_STORAGE_RELOAD =
  'data-recued-persistent-storage-reload';
const SECURE_ACCESS_HANDOFF = 'data-recued-secure-access-handoff';
const SECURE_ACCESS_LOCAL_URL = 'data-recued-secure-access-local-url';
const SECURE_ACCESS_HTTPS_INPUT = 'data-recued-secure-access-https-input';
const SECURE_ACCESS_STATUS = 'data-recued-secure-access-status';
const SECURE_ACCESS_CLEAN_TARGET = 'data-secure-access-clean-target';
const MULTI_TAB_PAIR_STORAGE_KEY = 'recued.e2e.multi-tab-pair-state';
const MULTI_TAB_TRANSITION_STAGE_KEY =
  'recued.e2e.multi-tab-transition-stage';
const MULTI_TAB_TRANSITION_RELEASE_KEY =
  'recued.e2e.multi-tab-transition-release';
const MULTI_TAB_TAKEOVER_REQUEST_COUNT_KEY =
  'recued.e2e.multi-tab-takeover-request-count';

installFullAppHooks();

for (const journey of ['first pair', 'reconnect']) {
  for (const hint of ['normal', 'navigator', 'userAgent', 'platform', 'userAgentData', 'userAgentData.platform']) {
    test(`device-name hints preserve ${journey} with ${hint === 'normal' ? 'normal access' : `blocked ${hint}`}`, async ({ page }) => {
      await page.setViewportSize({ width: hint === 'normal' ? 1280 : 390, height: 900 });
      await page.addInitScript(blocked => {
        const denied = (): never => { throw new Error('Private browser hint policy'); };
        if (blocked === 'navigator') {
          Object.defineProperty(window, 'navigator', { configurable: true, get: denied });
          return;
        }
        const hints = { platform: 'macOS' };
        Object.defineProperties(navigator, {
          userAgent: { configurable: true, value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
          platform: { configurable: true, value: 'MacIntel' },
          userAgentData: { configurable: true, value: hints },
        });
        if (blocked === 'userAgentData.platform') Object.defineProperty(hints, 'platform', { get: denied });
        else if (blocked !== 'normal') Object.defineProperty(navigator, blocked, { configurable: true, get: denied });
      }, hint);
      const base = journey === 'first pair'
        ? `${HARNESS_URL}?journey=multi-tab-pair&chat=session`
        : `${HARNESS_URL}?journey=reauth&chat=session`;
      const exactUrl = `${base}#chat/session/chat_1`;
      const entryUrl = journey === 'first pair'
        ? `${base}&code=PAIR5678&recued_pair_resume=same-origin#chat/session/chat_1`
        : exactUrl;
      await page.goto(entryUrl);
      const draft = 'Keep this unsent thought while browser hints are blocked.';
      if (journey === 'reconnect') {
        await page.waitForFunction(() => window.__app?.ready === true);
        await page.locator(`[${CHAT_INPUT}]`).fill(draft);
        await page.evaluate(() => window.__app.forceReauth());
      }
      const form = page.getByRole('form', { name: journey === 'first pair' ? 'Pair this browser' : 'Reconnect this browser', exact: true });
      await expect(form).toBeVisible();
      await page.waitForFunction(() => window.__app?.ready === true);
      expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(0);
      await page.evaluate(() => {
        const send = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          if (new URL(url, location.href).pathname === '/auth/pair') {
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { displayName?: unknown } : null;
            document.documentElement.setAttribute('data-device-name-post', typeof body?.displayName === 'string' ? body.displayName : 'missing');
          }
          return send(input, init);
        };
      });
      await form.locator('#webclient-pair-code-input-recovery-0').fill(`${Array(23).fill('abandon').join(' ')} art`);
      const submit = form.getByRole('button', { name: journey === 'first pair' ? 'Pair this device' : 'Reconnect this browser', exact: true });
      await submit.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
      await expect(form).toHaveCount(0);
      await expect(page).toHaveURL(exactUrl);
      await expect(page.locator('html')).toHaveAttribute('data-device-name-post', hint === 'normal' ? 'Chrome on macOS' : 'Web browser');
      expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(1);
      expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
      if (journey === 'reconnect') {
        await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue(draft);
        await expect(page.locator(`[${CHAT_INPUT}]`)).toBeFocused();
      }
      await expect(page.locator('body')).not.toContainText('Private browser hint policy');
    });
  }
}

test('cold-start credential corruption becomes a safe guided repair and exact return', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.setViewportSize({ width: 390, height: 844 });
  const target =
    `${HARNESS_URL}?chat=session&journey=credential-corruption&code=PAIR1234#chat/session/chat_1`;
  await page.goto(target);
  await page.waitForFunction(() => window.__app?.ready === true);

  const repair = page.locator(`[${COLD_START_CREDENTIAL_REPAIR}]`);
  await expect(repair).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Reconnect this browser' }),
  ).toBeVisible();
  await expect(repair).toContainText('Browser access needs repair');
  await expect(repair).toContainText(
    'Your server data is not being cleared.',
  );
  await expect(repair).toContainText(
    'Connections, Chat history, and other work stored on your server stay unchanged.',
  );
  await expect(repair).toContainText('https://alice.recued.cloud:8443');
  await expect(repair).toContainText('recued pair');
  await expect(page.locator('#webclient-pair-code-input-form')).toHaveCount(0);

  const confirmRepair = repair.locator(
    `[${COLD_START_CREDENTIAL_REPAIR_ACTION}]`,
  );
  await expect(confirmRepair).toHaveAccessibleName(
    'Clear local access and reconnect',
  );
  await expect(confirmRepair).toHaveAttribute(
    'aria-describedby',
    'webclient-cold-start-credential-repair-consequence',
  );
  await expect(confirmRepair).toBeFocused();

  const reload = repair.locator(
    `[${COLD_START_CREDENTIAL_RELOAD_ACTION}]`,
  );
  await expect(reload).not.toHaveAttribute('aria-describedby');
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    reload.click(),
  ]);
  await page.waitForFunction(() => window.__app?.ready === true);

  await expect(page).toHaveURL(target);
  await expect(repair).toContainText(
    'This tab reloaded, but this browser’s saved sign-in still needs fixing.',
  );
  await expect(repair).toContainText(
    'page you opened is still chosen',
  );
  await expect(page.locator(`[${SHELL_HOST}]`)).toHaveCount(0);
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toHaveCount(0);
  await expect(page.locator('#webclient-pair-code-input-form')).toHaveCount(0);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    STARTUP_RELOAD_RECOVERY_SESSION_KEY,
  )).toBeNull();
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(0);
  await expect(confirmRepair).toHaveAttribute(
    'aria-describedby',
    'webclient-cold-start-credential-repair-consequence webclient-cold-start-credential-repair-context',
  );
  await expect(reload).toHaveAttribute(
    'aria-describedby',
    'webclient-cold-start-credential-repair-context',
  );
  await expect(confirmRepair).toBeFocused();

  await page.setViewportSize({ width: 280, height: 653 });
  const narrowLayout = await page.evaluate((attribute) => {
    const surface = document.querySelector(`[${attribute}]`);
    if (!(surface instanceof HTMLElement)) {
      throw new Error('cold-start credential repair surface is missing');
    }
    const rect = surface.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      buttonHeights: [...surface.querySelectorAll('button')]
        .map((button) => button.getBoundingClientRect().height),
    };
  }, COLD_START_CREDENTIAL_REPAIR);
  expect(narrowLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowLayout.right).toBeLessThanOrEqual(
    narrowLayout.viewportWidth + 0.5,
  );
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
    narrowLayout.viewportWidth,
  );
  expect(narrowLayout.buttonHeights).toHaveLength(2);
  expect(
    narrowLayout.buttonHeights.every((height) => height >= 44),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath(`full-app-cold-start-credential-repair-mobile.png`),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await confirmRepair.click();

  const pairForm = page.locator('#webclient-pair-code-input-form');
  await expect(pairForm).toBeVisible();
  const notice = pairForm.locator(`[${PAIR_REAUTH_NOTICE}]`);
  await expect(notice).toContainText('A sign-in Recued could not read has been cleared');
  await expect(notice).toContainText(
    'This browser could not unlock its saved sign-in',
  );
  await expect(notice).not.toContainText(
    "Your server will not take the sign-in saved in this browser any more",
  );
  await expect(
    pairForm.locator('#webclient-pair-code-input-server-url'),
  ).toHaveValue('https://alice.recued.cloud:8443');
  await expect(
    pairForm.locator('#webclient-pair-code-input-code'),
  ).toHaveValue('PAIR1234');
  const firstRecoveryWord = pairForm.locator(
    '#webclient-pair-code-input-recovery-0',
  );
  await expect(firstRecoveryWord).toBeFocused();

  const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
  await firstRecoveryWord.fill(recoveryKey);
  await pairForm.getByRole('button', {
    name: 'Reconnect this browser',
  }).click();

  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toContainText(
    'back where you left off',
  );
  expect(
    await page.evaluate(() => window.__app.rpcCallCount('chat.send')),
  ).toBe(0);
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(1);
  expect(pageErrors).toHaveLength(0);
});

test('partial local access becomes an explained repair with preserved context', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.setViewportSize({ width: 390, height: 844 });
  const target =
    `${HARNESS_URL}?chat=session&journey=partial-local-state&code=PAIR5678#chat/session/chat_1`;
  await page.goto(target);
  await page.waitForFunction(() => window.__app?.ready === true);

  const repair = page.locator(`[${COLD_START_CREDENTIAL_REPAIR}]`);
  await expect(repair).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Finish reconnecting this browser' }),
  ).toBeVisible();
  await expect(repair).toContainText('Browser setup was interrupted');
  await expect(repair).toContainText('incomplete saved sign-in');
  await expect(repair).toContainText(
    'Your server data is not being cleared.',
  );
  await expect(repair).toContainText('https://alice.recued.cloud:8443');
  await expect(page.locator('#webclient-pair-code-input-form')).toHaveCount(0);

  const confirmRepair = repair.locator(
    `[${COLD_START_CREDENTIAL_REPAIR_ACTION}]`,
  );
  await expect(confirmRepair).toHaveAccessibleName(
    'Clear incomplete setup and reconnect',
  );
  await expect(confirmRepair).toHaveAttribute(
    'aria-describedby',
    'webclient-cold-start-credential-repair-consequence',
  );
  await expect(confirmRepair).toBeFocused();

  const reload = repair.locator(
    `[${COLD_START_CREDENTIAL_RELOAD_ACTION}]`,
  );
  await expect(reload).not.toHaveAttribute('aria-describedby');
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    reload.click(),
  ]);
  await page.waitForFunction(() => window.__app?.ready === true);

  await expect(page).toHaveURL(target);
  await expect(repair).toContainText(
    'This tab reloaded, but this browser’s saved sign-in still needs fixing.',
  );
  await expect(repair).toContainText(
    'page you opened is still chosen',
  );
  await expect(page.locator(`[${SHELL_HOST}]`)).toHaveCount(0);
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toHaveCount(0);
  await expect(page.locator('#webclient-pair-code-input-form')).toHaveCount(0);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    STARTUP_RELOAD_RECOVERY_SESSION_KEY,
  )).toBeNull();
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(0);
  await expect(confirmRepair).toHaveAttribute(
    'aria-describedby',
    'webclient-cold-start-credential-repair-consequence webclient-cold-start-credential-repair-context',
  );
  await expect(reload).toHaveAttribute(
    'aria-describedby',
    'webclient-cold-start-credential-repair-context',
  );
  await expect(confirmRepair).toBeFocused();

  await page.setViewportSize({ width: 280, height: 653 });
  const narrowLayout = await page.evaluate((attribute) => {
    const surface = document.querySelector(`[${attribute}]`);
    if (!(surface instanceof HTMLElement)) {
      throw new Error('partial local-state repair surface is missing');
    }
    const rect = surface.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      buttonHeights: [...surface.querySelectorAll('button')]
        .map((button) => button.getBoundingClientRect().height),
    };
  }, COLD_START_CREDENTIAL_REPAIR);
  expect(narrowLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowLayout.right).toBeLessThanOrEqual(
    narrowLayout.viewportWidth + 0.5,
  );
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
    narrowLayout.viewportWidth,
  );
  expect(narrowLayout.buttonHeights).toHaveLength(2);
  expect(
    narrowLayout.buttonHeights.every((height) => height >= 44),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath(`full-app-partial-local-state-repair-mobile.png`),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await confirmRepair.click();

  const pairForm = page.locator('#webclient-pair-code-input-form');
  await expect(pairForm).toBeVisible();
  const notice = pairForm.locator(`[${PAIR_REAUTH_NOTICE}]`);
  await expect(notice).toContainText('An unfinished setup has been cleared');
  await expect(notice).toContainText(
    'An earlier setup stopped before everything was saved here.',
  );
  await expect(notice).not.toContainText(
    "Your server will not take the sign-in saved in this browser any more",
  );
  await expect(
    pairForm.locator('#webclient-pair-code-input-server-url'),
  ).toHaveValue('https://alice.recued.cloud:8443');
  await expect(
    pairForm.locator('#webclient-pair-code-input-code'),
  ).toHaveValue('PAIR5678');
  const firstRecoveryWord = pairForm.locator(
    '#webclient-pair-code-input-recovery-0',
  );
  await expect(firstRecoveryWord).toBeFocused();

  const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
  await firstRecoveryWord.fill(recoveryKey);
  await pairForm.getByRole('button', {
    name: 'Reconnect this browser',
  }).click();

  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toContainText(
    'back where you left off',
  );
  expect(
    await page.evaluate(() => window.__app.rpcCallCount('chat.send')),
  ).toBe(0);
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(1);
  expect(pageErrors).toHaveLength(0);
});

test('a credential-repair reload that recovers confirms once on the exact route', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  const target =
    `${HARNESS_URL}?journey=credential-corruption&credential_reload_recovers=1&keep=credential%20ready#connections`;
  await page.setViewportSize({ width: 280, height: 720 });
  await page.goto(target);
  await page.waitForFunction(() => window.__app?.ready === true);

  const repair = page.locator(`[${COLD_START_CREDENTIAL_REPAIR}]`);
  await expect(repair).toBeVisible();
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    repair.locator(`[${COLD_START_CREDENTIAL_RELOAD_ACTION}]`).click(),
  ]);
  await page.waitForFunction(() => window.__app?.ready === true);

  await expect(page).toHaveURL(target);
  await expect(repair).toHaveCount(0);
  await expect(page.locator('#webclient-boot-splash')).toHaveCount(0);
  await expect(page.locator(`[${CONNECTIONS_ROUTE}]`)).toBeVisible();
  await expect(page.locator(`[${SHELL_CONTENT}]`)).toBeFocused();
  const receipt = page.locator(`[${CONNECTION_BANNER}]`);
  await expect(receipt).toHaveAttribute('data-state', 'restored');
  await expect(receipt).toContainText(STARTUP_RECOVERY_RETURN_RECEIPT_COPY);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    STARTUP_RELOAD_RECOVERY_SESSION_KEY,
  )).toBeNull();

  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(target);
  await expect(page.locator(`[${CONNECTIONS_ROUTE}]`)).toBeVisible();
  await expect(receipt).toHaveAttribute('data-state', 'ok');
  await expect(receipt).not.toContainText('Recued started up again');
  expect(pageErrors).toHaveLength(0);
});

test('persistent-storage startup failure guides an in-place retry and exact return', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session&journey=persistent-storage#chat/session/chat_1`,
  );

  const recovery = page.locator(`[${PERSISTENT_STORAGE_RECOVERY}]`);
  await expect(
    page.getByRole('region', { name: 'Close another Recued tab' }),
  ).toBeVisible();
  await expect(recovery).toContainText('Browser storage is busy');
  await expect(recovery).toContainText('Your server data is safe.');
  await expect(recovery).toContainText(
    'Retrying here keeps this tab on the page you opened.',
  );
  await expect(recovery).toContainText(
    'Waiting for other Recued tabs or windows',
  );
  await expect(page.locator(`[${SHELL_HOST}]`)).toHaveCount(0);

  const retry = recovery.locator(`[${PERSISTENT_STORAGE_RETRY}]`);
  await expect(retry).toHaveAccessibleName('Check again');
  await expect(retry).toHaveAttribute(
    'aria-describedby',
    'webclient-persistent-storage-recovery-safety',
  );
  await expect(retry).toBeFocused();

  await page.setViewportSize({ width: 280, height: 653 });
  const narrowLayout = await recovery.evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(narrowLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowLayout.right).toBeLessThanOrEqual(
    narrowLayout.viewportWidth + 0.5,
  );
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
    narrowLayout.viewportWidth,
  );
  const narrowRetryBottom = await retry.evaluate(
    (button) => button.getBoundingClientRect().bottom,
  );
  expect(narrowRetryBottom).toBeLessThanOrEqual(653.5);
  await page.screenshot({
    path: test.info().outputPath(`full-app-persistent-storage-recovery-mobile.png`),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await retry.click();
  await expect(
    page.getByRole('region', { name: 'Make room for browser storage' }),
  ).toBeVisible();
  await expect(recovery.getByRole('alert')).toContainText(
    'There is still no room.',
  );
  await expect(retry).toBeFocused();

  await retry.click();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator(`[${SHELL_HOST}]`)).toBeVisible();
  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  expect(await page.evaluate(() => window.__app.activeRoute())).toBe('chat');
  expect(
    await page.evaluate(() => window.__app.rpcCallCount('chat.send')),
  ).toBe(0);
});

test('persistent-storage reload that stays blocked preserves recovery context and exact return', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  const target =
    `${HARNESS_URL}?journey=persistent-storage&keep=storage%20reload#connections`;
  await page.setViewportSize({ width: 280, height: 720 });
  await page.goto(target);

  const recovery = page.locator(`[${PERSISTENT_STORAGE_RECOVERY}]`);
  await expect(recovery).toContainText('Browser storage is busy');
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    recovery.locator(`[${PERSISTENT_STORAGE_RELOAD}]`).click(),
  ]);

  await expect(page).toHaveURL(target);
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText(
    'This tab reloaded, but browser storage still did not open.',
  );
  await expect(recovery).toContainText(
    'page you opened is still chosen',
  );
  await expect(page.locator(`[${SHELL_HOST}]`)).toHaveCount(0);
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toHaveCount(0);
  await expect(page.getByRole('form')).toHaveCount(0);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    STARTUP_RELOAD_RECOVERY_SESSION_KEY,
  )).toBeNull();

  const retry = recovery.locator(`[${PERSISTENT_STORAGE_RETRY}]`);
  const reload = recovery.locator(`[${PERSISTENT_STORAGE_RELOAD}]`);
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute(
    'aria-describedby',
    'webclient-persistent-storage-recovery-safety webclient-persistent-storage-recovery-context',
  );
  await expect(reload).toHaveAttribute(
    'aria-describedby',
    'webclient-persistent-storage-recovery-safety webclient-persistent-storage-recovery-context',
  );
  const narrowLayout = await recovery.evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      buttonHeights: [...surface.querySelectorAll('button')]
        .map((button) => button.getBoundingClientRect().height),
    };
  });
  expect(narrowLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowLayout.right).toBeLessThanOrEqual(
    narrowLayout.viewportWidth + 0.5,
  );
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
    narrowLayout.viewportWidth,
  );
  expect(narrowLayout.buttonHeights).toHaveLength(2);
  expect(
    narrowLayout.buttonHeights.every((height) => height >= 44),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath(`full-app-persistent-storage-reload-still-blocked-mobile.png`),
    fullPage: true,
  });

  await retry.click();
  await expect(recovery.getByRole('alert')).toContainText(
    'There is still no room.',
  );
  await expect(retry).toBeFocused();
  await retry.click();

  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(target);
  await expect(page.locator(`[${CONNECTIONS_ROUTE}]`)).toBeVisible();
  await expect(page.locator(`[${SHELL_CONTENT}]`)).toBeFocused();
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toContainText(
    STARTUP_RECOVERY_RETURN_RECEIPT_COPY,
  );
  await expect(page.getByRole('form')).toHaveCount(0);
  expect(pageErrors).toHaveLength(0);
});

test('persistent-storage reload recovery confirms once on the exact route', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  const target =
    `${HARNESS_URL}?journey=persistent-storage&storage_reload_recovers=1&keep=storage%20ready#connections`;
  await page.setViewportSize({ width: 280, height: 720 });
  await page.goto(target);

  const recovery = page.locator(`[${PERSISTENT_STORAGE_RECOVERY}]`);
  await expect(recovery).toBeVisible();
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    recovery.locator(`[${PERSISTENT_STORAGE_RELOAD}]`).click(),
  ]);
  await page.waitForFunction(() => window.__app?.ready === true);

  await expect(page).toHaveURL(target);
  await expect(recovery).toHaveCount(0);
  await expect(page.locator('#webclient-boot-splash')).toHaveCount(0);
  await expect(page.locator(`[${CONNECTIONS_ROUTE}]`)).toBeVisible();
  await expect(page.locator(`[${SHELL_CONTENT}]`)).toBeFocused();
  const receipt = page.locator(`[${CONNECTION_BANNER}]`);
  await expect(receipt).toHaveAttribute('data-state', 'restored');
  await expect(receipt).toContainText(STARTUP_RECOVERY_RETURN_RECEIPT_COPY);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    STARTUP_RELOAD_RECOVERY_SESSION_KEY,
  )).toBeNull();

  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(target);
  await expect(page.locator(`[${CONNECTIONS_ROUTE}]`)).toBeVisible();
  await expect(receipt).toHaveAttribute('data-state', 'ok');
  await expect(receipt).not.toContainText('Recued started up again');
  expect(pageErrors).toHaveLength(0);
});

test("insecure HTTP resumes pairing at the chosen page's own secure origin", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journeyQuery =
    '?chat=session&journey=secure-access&url=https%3A%2F%2Fattacker.example%2Fcollect&code=PAIR5678';
  const resumeQuery = 'recued_pair_resume=same-origin';
  await page.goto(
    `${HARNESS_URL}${journeyQuery}#chat/session/chat_1`,
  );

  const handoff = page.locator(`[${SECURE_ACCESS_HANDOFF}]`);
  await expect(
    page.getByRole('region', { name: 'Choose where you want to continue' }),
  ).toBeVisible();
  await expect(handoff).toContainText('On the server computer');
  await expect(handoff).toContainText('On this or another device');
  await expect(handoff).toContainText(
    'localhost points to that device—not your Recued server',
  );
  await expect(handoff).toContainText(
    'This link may include a one-time pairing code; keep it private.',
  );
  await expect(handoff).toContainText('Recued stopped before changing anything');
  await expect(page.locator(`[${SHELL_HOST}]`)).toHaveCount(0);
  await expect(
    handoff.getByRole('heading', {
      name: 'Choose where you want to continue',
    }),
  ).toBeFocused();

  const localUrl = handoff.locator(`[${SECURE_ACCESS_LOCAL_URL}]`);
  const exactLocalUrl =
    `http://localhost:${new URL(HARNESS_URL).port}/full-app-harness.html${journeyQuery}&${resumeQuery}#chat/session/chat_1`;
  await expect(localUrl).toHaveValue(exactLocalUrl);
  await expect(handoff.locator(`[${SECURE_ACCESS_HTTPS_INPUT}]`)).toHaveValue('');
  expect(await handoff.textContent()).not.toContain('https://192.168.1.42');

  const localAction = handoff.getByRole('button', {
    name: 'This is the server computer',
  });
  const primaryContrast = await localAction.evaluate((button) => {
    const luminance = (value: string): number => {
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
      const [r, g, b] = [0, 1, 2].map((index) => {
        const normalized = (channels[index] ?? 0) / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    const read = (): number => {
      const style = getComputedStyle(button);
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + 0.05)
        / (Math.min(foreground, background) + 0.05);
    };
    document.documentElement.dataset.theme = 'light';
    const light = read();
    document.documentElement.dataset.theme = 'dark';
    const dark = read();
    document.documentElement.dataset.theme = 'light';
    return { light, dark };
  });
  expect(primaryContrast.light).toBeGreaterThanOrEqual(4.5);
  expect(primaryContrast.dark).toBeGreaterThanOrEqual(4.5);

  await page.setViewportSize({ width: 280, height: 653 });
  const narrowLayout = await handoff.evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(narrowLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowLayout.right).toBeLessThanOrEqual(
    narrowLayout.viewportWidth + 0.5,
  );
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
    narrowLayout.viewportWidth,
  );
  const localActionBottom = await localAction.evaluate(
    (button) => button.getBoundingClientRect().bottom,
  );
  expect(localActionBottom).toBeLessThanOrEqual(653.5);
  await page.screenshot({
    path: test.info().outputPath(`full-app-secure-access-handoff-mobile.png`),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await handoff.getByRole('button', { name: 'Copy link' }).click();
  await expect(handoff.locator(`[${SECURE_ACCESS_STATUS}]`)).toContainText(
    'Localhost link copied',
  );

  const httpsInput = handoff.locator(`[${SECURE_ACCESS_HTTPS_INPUT}]`);
  await httpsInput.fill('http://alice.recued.cloud');
  await handoff.getByRole('button', { name: 'Open secure page' }).click();
  await expect(handoff.getByRole('alert')).toHaveText(
    'Use a safe address. It has to start with https://.',
  );
  await expect(httpsInput).toHaveAttribute('aria-invalid', 'true');
  await expect(httpsInput).toHaveAttribute(
    'aria-errormessage',
    'webclient-secure-access-status',
  );
  await expect(httpsInput).toBeFocused();

  await httpsInput.fill('https://alice.recued.cloud:8443');
  expect(await httpsInput.getAttribute('aria-invalid')).toBeNull();
  expect(await httpsInput.getAttribute('aria-errormessage')).toBeNull();
  await expect(handoff.locator(`[${SECURE_ACCESS_STATUS}]`)).toBeEmpty();
  await handoff.getByRole('button', { name: 'Open secure page' }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'data-secure-access-target',
    `https://alice.recued.cloud:8443/full-app-harness.html${journeyQuery}&${resumeQuery}#chat/session/chat_1`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(handoff).toHaveCount(0);
  const pairForm = page.getByRole('form', { name: 'Pair this browser' });
  await expect(pairForm).toBeVisible();
  await expect(pairForm.locator(`[${PAIR_SECURE_RESUME_NOTICE}]`)).toContainText(
    'Secure address carried over',
  );
  await expect(pairForm.locator(`[${PAIR_SECURE_RESUME_NOTICE}]`)).toContainText(
    "Recued will pair with this page's own address: https://alice.recued.cloud:8443",
  );
  await expect(pairForm.locator(`[${PAIR_SECURE_RESUME_NOTICE}]`)).toContainText(
    'Your pairing code is ready too. Carry on with your recovery key.',
  );
  await expect(pairForm).not.toContainText('attacker.example');
  const serverUrl = pairForm.locator('#webclient-pair-code-input-server-url');
  await expect(serverUrl).toHaveValue('https://alice.recued.cloud:8443');
  await expect(serverUrl).toHaveAttribute('readonly', '');
  await expect(serverUrl).toHaveAttribute(
    'aria-describedby',
    'webclient-pair-code-input-secure-resume-notice',
  );
  await expect(
    pairForm.locator('#webclient-pair-code-input-code'),
  ).toHaveValue('PAIR5678');
  await expect(pairForm.getByText('(carried over)', { exact: true })).toBeVisible();
  await expect(pairForm).toContainText(
    'Changing servers also clears any pairing code.',
  );
  await expect(
    pairForm.locator('#webclient-pair-code-input-recovery-0'),
  ).toBeFocused();
  await expect(page.locator(`[${SHELL_HOST}]`)).toHaveCount(0);
  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  expect(await page.evaluate(() => window.__app.activeRoute())).toBe('pairing');
  expect(
    await page.evaluate(() => window.__app.rpcCallCount('chat.send')),
  ).toBe(0);

  await page.setViewportSize({ width: 280, height: 653 });
  const arrivalLayout = await pairForm.evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(arrivalLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(arrivalLayout.right).toBeLessThanOrEqual(
    arrivalLayout.viewportWidth + 0.5,
  );
  expect(arrivalLayout.documentWidth).toBeLessThanOrEqual(
    arrivalLayout.viewportWidth,
  );
  await page.screenshot({
    path: test.info().outputPath(`full-app-secure-access-arrival-mobile.png`),
    fullPage: true,
  });

  await pairForm.getByRole('button', {
    name: 'Use a different server address',
  }).click();
  await expect(serverUrl).not.toHaveAttribute('readonly', '');
  await expect(serverUrl).toBeFocused();
  await expect(
    pairForm.locator('#webclient-pair-code-input-code'),
  ).toHaveValue('');
  expect(await serverUrl.evaluate((input) => ({
    start: (input as HTMLInputElement).selectionStart,
    end: (input as HTMLInputElement).selectionEnd,
    length: (input as HTMLInputElement).value.length,
  }))).toEqual({
    start: 0,
    end: 'https://alice.recued.cloud:8443'.length,
    length: 'https://alice.recued.cloud:8443'.length,
  });
});

test('pairing inputs stay full-sized across desktop and narrow screens', async ({ page }) => {
  const target =
    `${HARNESS_URL}?journey=multi-tab-pair&code=PAIR5678`
    + '&recued_pair_resume=same-origin#connections';
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(target);
  await page.waitForFunction(() => window.__app?.ready === true);

  const form = page.getByRole('form', { name: 'Pair this browser' });
  await expect(form).toBeVisible();
  const inputs = form.locator('input:visible');
  await expect(inputs).toHaveCount(26);
  const desktopHeights = await inputs.evaluateAll((fields) => fields.map(
    (field) => field.getBoundingClientRect().height,
  ));
  expect(Math.min(...desktopHeights)).toBeGreaterThanOrEqual(36);

  await page.setViewportSize({ width: 280, height: 653 });
  const mobileGeometry = await form.evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    const heights = [...surface.querySelectorAll<HTMLInputElement>('input')]
      .filter((field) => field.getBoundingClientRect().height > 0)
      .map((field) => field.getBoundingClientRect().height);
    return {
      left: rect.left,
      right: rect.right,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      minimumInputHeight: Math.min(...heights),
    };
  });
  expect(mobileGeometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(mobileGeometry.right).toBeLessThanOrEqual(
    mobileGeometry.viewportWidth + 0.5,
  );
  expect(mobileGeometry.documentWidth).toBeLessThanOrEqual(
    mobileGeometry.viewportWidth,
  );
  expect(mobileGeometry.minimumInputHeight).toBeGreaterThanOrEqual(44);
});

test('recovery generation keeps every action full-sized', async ({ page }) => {
  const target =
    `${HARNESS_URL}?journey=multi-tab-pair&code=PAIR5678`
    + '&recued_pair_resume=same-origin#connections';
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(target);
  await page.waitForFunction(() => window.__app?.ready === true);

  const form = page.getByRole('form', { name: 'Pair this browser' });
  await form.getByRole('button', {
    name: 'Make a new one',
    exact: true,
  }).click();
  const generate = form.getByRole('button', {
    name: 'Generate a new recovery key',
  });
  expect((await generate.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await generate.click();

  const generationActions = form.getByRole('button', {
    name: /^(Start over|I've written it down — continue)$/,
  });
  await expect(generationActions).toHaveCount(2);
  const desktopHeights = await generationActions.evaluateAll(
    (buttons) => buttons.map((button) => button.getBoundingClientRect().height),
  );
  expect(Math.min(...desktopHeights)).toBeGreaterThanOrEqual(36);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileGeometry = await generationActions.evaluateAll((buttons) => ({
    heights: buttons.map((button) => button.getBoundingClientRect().height),
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(Math.min(...mobileGeometry.heights)).toBeGreaterThanOrEqual(44);
  expect(mobileGeometry.documentWidth).toBeLessThanOrEqual(
    mobileGeometry.viewportWidth,
  );
});

test('successful secure pairing stays clean through reload, Back, and Forward', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journeyQuery =
    '?chat=session&journey=secure-access&url=https%3A%2F%2Fattacker.example%2Fcollect&code=PAIR5678';
  await page.goto(`${HARNESS_URL}${journeyQuery}#chat/session/chat_1`);

  const handoff = page.locator(`[${SECURE_ACCESS_HANDOFF}]`);
  await handoff.locator(`[${SECURE_ACCESS_HTTPS_INPUT}]`).fill(
    'https://alice.recued.cloud:8443',
  );
  await handoff.getByRole('button', { name: 'Open secure page' }).click();
  await page.waitForFunction(() => window.__app?.ready === true);

  const pairForm = page.getByRole('form', { name: 'Pair this browser' });
  await expect(pairForm).toBeVisible();
  const pairingCode = pairForm.locator('#webclient-pair-code-input-code');
  await expect(pairingCode).toHaveValue('PAIR5678');
  await pairingCode.fill('PAIR 56 78');
  await expect(pairingCode).toHaveValue('PAIR5678');
  const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
  await pairForm.locator('#webclient-pair-code-input-recovery-0').fill(
    recoveryKey,
  );
  await page.setViewportSize({ width: 280, height: 653 });
  await pairForm.getByRole('button', { name: 'Pair this device' }).click();

  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  await expect(page.locator(`[${SHELL_HOST}]`)).toBeVisible();
  await expect(pairForm).toHaveCount(0);
  await expect(page.locator('#webclient-boot-splash')).toHaveCount(0);
  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  await expect(page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.locator(`[${CHAT_INPUT}]`)).toBeVisible();
  await expect(page.locator(`[${SHELL_CONTENT}]`)).toBeFocused();
  expect(await page.evaluate(() => window.__app.lastPairingCode?.()))
    .toBe('PAIR5678');

  const cleanTarget =
    'https://alice.recued.cloud:8443/full-app-harness.html?chat=session&journey=secure-access&url=https%3A%2F%2Fattacker.example%2Fcollect#chat/session/chat_1';
  const cleanHarnessUrl =
    `${HARNESS_URL}?chat=session&journey=secure-access&url=https%3A%2F%2Fattacker.example%2Fcollect#chat/session/chat_1`;
  await expect(page.locator('html')).not.toHaveAttribute(
    'data-secure-access-target',
  );
  await expect(page.locator('html')).toHaveAttribute(
    SECURE_ACCESS_CLEAN_TARGET,
    cleanTarget,
  );
  await expect(page).toHaveURL(cleanHarnessUrl);
  expect(cleanTarget).not.toContain('code=');
  expect(cleanTarget).not.toContain('recued_pair_resume');

  const receipt = page.locator(`[${CONNECTION_BANNER}]`);
  await expect(receipt).toHaveAttribute('data-state', 'restored');
  await expect(receipt).toHaveAttribute('role', 'status');
  await expect(receipt).toContainText(
    'This browser is paired. Your sign-in is saved here, and your page is ready.',
  );
  const narrowLayout = await page.evaluate((bannerSelector) => {
    const banner = document.querySelector(bannerSelector);
    if (!(banner instanceof HTMLElement)) {
      throw new Error('post-pair receipt is missing');
    }
    const rect = banner.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  }, `[${CONNECTION_BANNER}]`);
  expect(narrowLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowLayout.right).toBeLessThanOrEqual(
    narrowLayout.viewportWidth + 0.5,
  );
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
    narrowLayout.viewportWidth,
  );
  await page.screenshot({
    path: test.info().outputPath(`full-app-pair-success-return-mobile.png`),
    fullPage: true,
  });
  expect(
    await page.evaluate(() => window.__app.rpcCallCount('chat.send')),
  ).toBe(0);

  // A history/BFCache return must retire the transient success receipt even
  // before a full reload creates a fresh runtime.
  await page.goto(`${HARNESS_URL}?history-probe=away`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.goBack();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(cleanHarnessUrl);
  await expect(page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .toHaveAttribute('data-state', 'ok');
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .not.toContainText('This browser is paired');

  // Install before the next document starts so even a one-frame pair form or
  // visible loading splash is observable. The static harness mirrors the
  // production splash's short reveal grace period.
  await page.addInitScript(() => {
    const probe = {
      pairFormSeen: false,
      visibleSplashSeen: false,
    };
    (window as unknown as {
      __postPairContinuityProbe: typeof probe;
    }).__postPairContinuityProbe = probe;
    const observer = new MutationObserver(() => {
      if (document.querySelector('#webclient-pair-code-input-form')) {
        probe.pairFormSeen = true;
      }
    });
    observer.observe(document, { childList: true, subtree: true });
    const sample = (): void => {
      const splash = document.getElementById('webclient-boot-splash');
      if (splash !== null) {
        const style = getComputedStyle(splash);
        if (
          style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || '1') > 0
        ) {
          probe.visibleSplashSeen = true;
        }
      }
      const appReady = (window as unknown as {
        __app?: { ready?: boolean };
      }).__app?.ready === true;
      if (appReady) {
        observer.disconnect();
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);

  await expect(page).toHaveURL(cleanHarnessUrl);
  await expect(page.locator(`[${SHELL_HOST}]`)).toBeVisible();
  await expect(page.locator('#webclient-pair-code-input-form')).toHaveCount(0);
  await expect(page.locator('#webclient-boot-splash')).toHaveCount(0);
  await expect(page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .toHaveAttribute('data-state', 'ok');
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .not.toContainText('This browser is paired');
  expect(await page.evaluate(() => (
    window as unknown as {
      __postPairContinuityProbe: {
        pairFormSeen: boolean;
        visibleSplashSeen: boolean;
      };
    }
  ).__postPairContinuityProbe)).toEqual({
    pairFormSeen: false,
    visibleSplashSeen: false,
  });
  await page.screenshot({
    path: test.info().outputPath(`full-app-pair-refresh-continuity-mobile.png`),
    fullPage: true,
  });

  await page.goBack();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(HARNESS_URL);
  await expect(page.locator(`[${SECURE_ACCESS_HANDOFF}]`)).toHaveCount(0);
  await expect(page.locator('#webclient-pair-code-input-form')).toHaveCount(0);

  await page.goForward();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(cleanHarnessUrl);
  await expect(page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .toHaveAttribute('data-state', 'ok');
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .not.toContainText('This browser is paired');
});

test('a sibling pair form adopts another tab success at its own exact route', async ({
  page,
  context,
}) => {
  await page.evaluate(
    (key) => window.localStorage.removeItem(key),
    MULTI_TAB_PAIR_STORAGE_KEY,
  );
  const siblingErrors: Error[] = [];
  const sibling = await context.newPage();
  sibling.on('pageerror', (error) => siblingErrors.push(error));
  const resume = 'recued_pair_resume=same-origin';
  const sourceUrl =
    `${HARNESS_URL}?journey=multi-tab-pair&chat=session&keep=source%20tab&code=PAIR5678&${resume}#connections`;
  const siblingUrl =
    `${HARNESS_URL}?journey=multi-tab-pair&chat=session&keep=sibling%20tab&keep=sibling+two&code=PAIR9999&${resume}#chat/session/chat_1`;
  const cleanSourceUrl =
    `${HARNESS_URL}?journey=multi-tab-pair&chat=session&keep=source%20tab#connections`;
  const cleanSiblingUrl =
    `${HARNESS_URL}?journey=multi-tab-pair&chat=session&keep=sibling%20tab&keep=sibling+two#chat/session/chat_1`;

  try {
    await Promise.all([
      page.goto(sourceUrl),
      sibling.goto(siblingUrl),
    ]);
    await Promise.all([
      page.waitForFunction(() => window.__app?.ready === true),
      sibling.waitForFunction(() => window.__app?.ready === true),
    ]);

    const sourceForm = page.getByRole('form', { name: 'Pair this browser' });
    const siblingForm = sibling.getByRole('form', {
      name: 'Pair this browser',
    });
    await expect(sourceForm).toBeVisible();
    await expect(siblingForm).toBeVisible();

    const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
    await sourceForm.locator('#webclient-pair-code-input-recovery-0').fill(
      recoveryKey,
    );
    await sourceForm.getByRole('button', {
      name: 'Pair this device',
    }).click();

    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      sibling.waitForFunction(
        () => window.__app.activeRoute() === 'chat',
      ),
    ]);

    await expect(page).toHaveURL(cleanSourceUrl);
    await expect(sibling).toHaveURL(cleanSiblingUrl);
    await expect(sourceForm).toHaveCount(0);
    await expect(siblingForm).toHaveCount(0);
    await expect(sibling.locator(`[${SHELL_HOST}]`)).toBeVisible();
    await expect(sibling.locator(`[${CHAT_SESSION_ROW}="chat_1"]`))
      .toHaveAttribute('aria-current', 'page');
    await expect(sibling.locator(`[${SHELL_CONTENT}]`)).toBeFocused();
    await expect(sibling.locator(`[${CONNECTION_BANNER}]`))
      .toHaveAttribute('data-state', 'ok');
    await expect(sibling.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('This browser is paired');
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .toHaveAttribute('data-state', 'restored');
    expect(await page.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(1);
    expect(await sibling.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(0);

    await sibling.setViewportSize({ width: 280, height: 653 });
    expect(await sibling.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }))).toEqual({
      documentWidth: 280,
      viewportWidth: 280,
    });
    await sibling.screenshot({
      path: test.info().outputPath(`full-app-multi-tab-pair-sibling-mobile.png`),
      fullPage: true,
    });
    expect(siblingErrors).toHaveLength(0);
  } finally {
    await sibling.close();
    await page.evaluate(
      (key) => window.localStorage.removeItem(key),
      MULTI_TAB_PAIR_STORAGE_KEY,
    );
  }
});

test('credential loss in one tab converges every sibling through one guided re-pair', async ({
  page,
  context,
}) => {
  await page.evaluate(
    (keys) => keys.forEach((key) => window.localStorage.removeItem(key)),
    [MULTI_TAB_TRANSITION_STAGE_KEY, MULTI_TAB_TRANSITION_RELEASE_KEY],
  );
  await page.evaluate(
    ({ key, pair }) => window.localStorage.setItem(key, JSON.stringify(pair)),
    {
      key: MULTI_TAB_PAIR_STORAGE_KEY,
      pair: {
        server_url: 'wss://alice.recued.cloud:8443/ws',
        server_public_key: HARNESS_SERVER_PUBLIC_KEY,
        webclient_token: {
          token_id: 'tok-multi-tab-original',
          ciphertext_b64: 'ciphertext-original',
          iv_b64: 'iv-original',
          issued_at: 1_700_000_000,
        },
        pair_metadata: {
          paired_at: 1_700_000_000,
          server_passport_fingerprint: 'fp-original',
          server_handle_at_pair: 'alice',
          instance_id: 'browser-multi-tab-original',
        },
        cert_pin_state: null,
      },
    },
  );
  const siblingErrors: Error[] = [];
  const sibling = await context.newPage();
  sibling.on('pageerror', (error) => siblingErrors.push(error));
  const sourceUrl =
    `${HARNESS_URL}?journey=multi-tab-credentials&pause_pair=1&chat=session&keep=source%20tab#connections`;
  const siblingUrl =
    `${HARNESS_URL}?journey=multi-tab-credentials&pause_pair=1&chat=session`
    + '&settle_reads=1&hold_rpc=recipe.list'
    + '&keep=sibling%20tab&keep=sibling+two#chat/session/chat_1';

  try {
    await Promise.all([page.goto(sourceUrl), sibling.goto(siblingUrl)]);
    await Promise.all([
      page.waitForFunction(() => window.__app?.ready === true),
      sibling.waitForFunction(() => window.__app?.ready === true),
    ]);
    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      sibling.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);

    const draft = 'Keep this sibling-tab diagnosis draft.';
    const siblingInput = sibling.locator(`[${CHAT_INPUT}]`);
    await siblingInput.fill(draft);
    await page.evaluate(() => window.__app.forceReauth());

    const sourceForm = page.getByRole('form', {
      name: 'Reconnect this browser',
    });
    const siblingForm = sibling.getByRole('form', {
      name: 'Reconnect this browser',
    });
    await expect(sourceForm).toBeVisible();
    await expect(siblingForm).toBeVisible();
    const siblingNotice = siblingForm.locator(`[${PAIR_REAUTH_NOTICE}]`);
    await expect(siblingNotice).toHaveAttribute('role', 'status');
    await expect(siblingNotice).toContainText(
      'Another tab changed your saved sign-in',
    );
    await expect(siblingNotice).toContainText(
      'This tab stopped using the old one.',
    );
    await expect(siblingNotice).toContainText(
      'Your page and the Chat message you had not sent are still in this tab.',
    );
    await expect(
      siblingForm.locator('#webclient-pair-code-input-server-url'),
    ).toHaveValue('https://alice.recued.cloud:8443');
    await expect(
      siblingForm.locator('#webclient-pair-code-input-recovery-0'),
    ).toBeFocused();

    await sibling.setViewportSize({ width: 280, height: 653 });
    const narrowLayout = await sibling.evaluate(() => {
      const form = document.getElementById('webclient-pair-code-input-form');
      if (!(form instanceof HTMLElement)) {
        throw new Error('sibling recovery form is missing');
      }
      const rect = form.getBoundingClientRect();
      return {
        formLeft: rect.left,
        formRight: rect.right,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(narrowLayout.formLeft).toBeGreaterThanOrEqual(-0.5);
    expect(narrowLayout.formRight).toBeLessThanOrEqual(
      narrowLayout.viewportWidth + 0.5,
    );
    expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
      narrowLayout.viewportWidth,
    );

    // The passive tab has started entering recovery material but has not
    // submitted. A sibling winner must explain the in-flight transition,
    // retire its stale one-time code, keep the partial recovery entry usable
    // while persistence is pending, then scrub the form on verified success.
    const siblingPairingCode = siblingForm.locator(
      '#webclient-pair-code-input-code',
    );
    const siblingRecoveryWord = siblingForm.locator(
      '#webclient-pair-code-input-recovery-0',
    );
    await siblingPairingCode.fill('STALE999');
    await siblingRecoveryWord.fill('zoo');
    await expect(siblingRecoveryWord).toBeFocused();

    const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
    await sourceForm.locator(
      '#webclient-pair-code-input-recovery-0',
    ).fill(recoveryKey);
    await sourceForm.getByRole('button', {
      name: 'Reconnect this browser',
    }).click();

    await page.waitForFunction(
      (key) => window.localStorage.getItem(key) === 'pair_metadata',
      MULTI_TAB_TRANSITION_STAGE_KEY,
    );
    const siblingInterrupted = siblingForm.locator(
      `[${PAIR_INTERRUPTED_NOTICE}]`,
    );
    await expect(siblingInterrupted).toHaveAttribute('role', 'status');
    await expect(siblingInterrupted).toContainText(
      'Another tab is reconnecting',
    );
    await expect(siblingInterrupted).toContainText(
      'go back to your page and the Chat message you had not sent by itself once the other tab finishes',
    );
    await expect(siblingInterrupted).toContainText(
      'What you typed as your recovery key stays here',
    );
    await expect(siblingPairingCode).toHaveValue('');
    await expect(siblingRecoveryWord).toHaveValue('zoo');
    await expect(siblingRecoveryWord).toBeFocused();
    expect(await sibling.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(0);
    await sibling.screenshot({
      path: test.info().outputPath(`full-app-guided-repair-sibling-winner-mobile.png`),
      fullPage: true,
    });

    await page.evaluate(
      (key) => window.localStorage.setItem(key, '1'),
      MULTI_TAB_TRANSITION_RELEASE_KEY,
    );

    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      sibling.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);
    await expect(page).toHaveURL(sourceUrl);
    await expect(sibling).toHaveURL(siblingUrl);
    await expect(sourceForm).toHaveCount(0);
    await expect(siblingForm).toHaveCount(0);
    expect(await sibling.evaluate(() => ({
      staleCodePresent: [...document.querySelectorAll('input')]
        .some((input) => input.value.includes('STALE999')),
      recoveryWordPresent: [...document.querySelectorAll('input')]
        .some((input) => input.value === 'zoo'),
    }))).toEqual({
      staleCodePresent: false,
      recoveryWordPresent: false,
    });
    await expect(sibling.locator(`[${CHAT_INPUT}]`)).toHaveValue(draft);
    await expect(sibling.locator(`[${CHAT_INPUT}]`)).toBeFocused();
    await expect(sibling.locator(`[${CONNECTION_BANNER}]`))
      .toHaveAttribute('data-state', 'ok');
    await expect(sibling.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Reconnected');
    await expect(sibling.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('This browser is paired');
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .toHaveAttribute('data-state', 'restored');
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .toContainText('Reconnected');
    expect(await page.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(1);
    expect(await sibling.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(0);
    // Recovery must complete while an optional activation read is still held.
    // Its later reply cannot replace edits made after the draft was restored.
    const restoredInput = sibling.locator(`[${CHAT_INPUT}]`);
    const editedDraft = `${draft} Edited after reconnect.`;
    await restoredInput.fill(editedDraft);
    await restoredInput.evaluate((input: HTMLTextAreaElement) => {
      input.setSelectionRange(5, 5);
    });
    expect(await sibling.evaluate(
      () => window.__app.releaseRpcResponses?.('recipe.list'),
    )).toBeGreaterThan(0);
    await expect(restoredInput).toHaveValue(editedDraft);
    await expect(restoredInput).toBeFocused();
    expect(await restoredInput.evaluate(
      (input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd],
    )).toEqual([5, 5]);
    expect(siblingErrors).toHaveLength(0);
  } finally {
    await sibling.close();
    await page.evaluate(
      (keys) => keys.forEach((key) => window.localStorage.removeItem(key)),
      [
        MULTI_TAB_PAIR_STORAGE_KEY,
        MULTI_TAB_TRANSITION_STAGE_KEY,
        MULTI_TAB_TRANSITION_RELEASE_KEY,
      ],
    );
  }
});

test('a stalled sibling reconnect becomes one safe exact-work takeover', async ({
  page,
  context,
}) => {
  await page.evaluate(
    ({ pairKey, stageKey, releaseKey, pair }) => {
      window.localStorage.setItem(pairKey, JSON.stringify(pair));
      window.localStorage.removeItem(stageKey);
      window.localStorage.removeItem(releaseKey);
    },
    {
      pairKey: MULTI_TAB_PAIR_STORAGE_KEY,
      stageKey: MULTI_TAB_TRANSITION_STAGE_KEY,
      releaseKey: MULTI_TAB_TRANSITION_RELEASE_KEY,
      pair: {
        server_url: 'wss://alice.recued.cloud:8443/ws',
        server_public_key: HARNESS_SERVER_PUBLIC_KEY,
        webclient_token: {
          token_id: 'tok-stalled-original',
          ciphertext_b64: 'ciphertext-original',
          iv_b64: 'iv-original',
          issued_at: 1_700_000_000,
        },
        pair_metadata: {
          paired_at: 1_700_000_000,
          server_passport_fingerprint: 'fp-original',
          server_handle_at_pair: 'alice',
          instance_id: 'browser-stalled-original',
        },
        cert_pin_state: null,
      },
    },
  );
  const siblingErrors: Error[] = [];
  const sibling = await context.newPage();
  sibling.on('pageerror', (error) => siblingErrors.push(error));
  const sourceUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&fail_pair_once=1&takeover_delay_ms=3000&chat=session&keep=source%20tab#connections`;
  const siblingUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&takeover_delay_ms=3000&chat=session&keep=sibling%20tab#chat/session/chat_1`;

  try {
    await Promise.all([page.goto(sourceUrl), sibling.goto(siblingUrl)]);
    await Promise.all([
      page.waitForFunction(() => window.__app?.ready === true),
      sibling.waitForFunction(() => window.__app?.ready === true),
    ]);
    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      sibling.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);

    const draft = 'Keep this stalled-takeover diagnosis draft.';
    await sibling.locator(`[${CHAT_INPUT}]`).fill(draft);
    await page.evaluate(() => window.__app.forceReauth());

    const sourceForm = page.getByRole('form', {
      name: 'Reconnect this browser',
    });
    const siblingForm = sibling.getByRole('form', {
      name: 'Reconnect this browser',
    });
    await expect(sourceForm).toBeVisible();
    await expect(siblingForm).toBeVisible();

    const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
    const siblingCode = siblingForm.locator(
      '#webclient-pair-code-input-code',
    );
    const siblingRecovery = siblingForm.locator(
      '#webclient-pair-code-input-recovery-0',
    );
    await siblingRecovery.fill(recoveryKey);
    await siblingCode.fill('STALE999');
    await siblingRecovery.focus();
    await siblingRecovery.evaluate((input) => {
      (input as HTMLInputElement).setSelectionRange(2, 5);
    });
    await sourceForm.locator(
      '#webclient-pair-code-input-recovery-0',
    ).fill(recoveryKey);
    await sourceForm.locator('#webclient-pair-code-input-code')
      .fill('SOURCE999');
    await sourceForm.getByRole('button', {
      name: 'Reconnect this browser',
    }).click();

    const sourceInterrupted = sourceForm.locator(
      `[${PAIR_INTERRUPTED_NOTICE}][data-local-finalize-retry]`,
    );
    await expect(sourceInterrupted).toContainText(
      'Server pairing is complete',
    );
    expect(await page.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(1);
    expect(await page.evaluate(() => window.__app.lastPairingCode?.()))
      .toBe('SOURCE999');

    const siblingInterrupted = siblingForm.locator(
      `[${PAIR_INTERRUPTED_NOTICE}]`,
    );
    await expect(siblingInterrupted).toHaveAttribute('role', 'status');
    await expect(siblingInterrupted).toContainText(
      'Another tab is reconnecting',
    );
    await expect(siblingInterrupted).not.toHaveAttribute(
      PAIR_TAKEOVER_READY,
      '',
    );
    await expect(siblingCode).toHaveValue('');
    await expect(siblingRecovery).toBeFocused();
    await expect(siblingRecovery).toHaveValue('abandon');
    expect(await siblingRecovery.evaluate((input) => ({
      start: (input as HTMLInputElement).selectionStart,
      end: (input as HTMLInputElement).selectionEnd,
    }))).toEqual({ start: 2, end: 5 });
    const waitingAction = siblingForm.getByRole('button', {
      name: 'Waiting for other tab…',
    });
    await expect(waitingAction).toBeDisabled();
    await expect(waitingAction).toHaveAttribute(
      'aria-describedby',
      'webclient-pair-code-input-interrupted-notice',
    );
    await expect(siblingForm).toContainText(
      'Recued lets only one carry on and brings the others back by itself.',
    );

    await expect(siblingInterrupted).toHaveAttribute(
      PAIR_TAKEOVER_READY,
      '',
    );
    await expect(siblingInterrupted).toContainText(
      'The other tab is taking longer',
    );
    await expect(siblingInterrupted).toContainText(
      'Recued lets only one carry on and brings the others back by itself',
    );
    await expect(siblingInterrupted).toContainText(
      'recovery key, your page, and the Chat message you had not sent stay here',
    );
    await expect(siblingRecovery).toBeFocused();
    await expect(siblingRecovery).toHaveValue('abandon');
    expect(await siblingRecovery.evaluate((input) => ({
      start: (input as HTMLInputElement).selectionStart,
      end: (input as HTMLInputElement).selectionEnd,
    }))).toEqual({ start: 2, end: 5 });

    const takeover = siblingForm.getByRole('button', {
      name: 'Reconnect in this tab',
    });
    await expect(takeover).toBeEnabled();
    await sibling.setViewportSize({ width: 280, height: 653 });
    const narrowLayout = await siblingForm.evaluate((form) => {
      const rect = form.getBoundingClientRect();
      const primary = form.querySelector<HTMLButtonElement>(
        '#webclient-pair-code-input-submit',
      )?.getBoundingClientRect();
      const recoveryGrid = form.querySelector<HTMLElement>(
        '.rx-recovery-words',
      );
      return {
        left: rect.left,
        right: rect.right,
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        primaryHeight: primary?.height ?? 0,
        recoveryColumnCount: recoveryGrid === null
          ? 0
          : getComputedStyle(recoveryGrid).gridTemplateColumns
            .split(' ').length,
      };
    });
    expect(narrowLayout.left).toBeGreaterThanOrEqual(-0.5);
    expect(narrowLayout.right).toBeLessThanOrEqual(
      narrowLayout.viewportWidth + 0.5,
    );
    expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
      narrowLayout.viewportWidth,
    );
    expect(narrowLayout.primaryHeight).toBeGreaterThanOrEqual(44);
    expect(narrowLayout.recoveryColumnCount).toBe(2);
    await sibling.screenshot({
      path: test.info().outputPath(`full-app-stalled-sibling-safe-takeover-mobile.png`),
      fullPage: true,
    });

    await siblingCode.fill('FRESH123');
    await takeover.click();
    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      sibling.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);

    await expect(page).toHaveURL(sourceUrl);
    await expect(sibling).toHaveURL(siblingUrl);
    await expect(sourceForm).toHaveCount(0);
    await expect(siblingForm).toHaveCount(0);
    await expect(sibling.locator(`[${CHAT_INPUT}]`)).toHaveValue(draft);
    await expect(sibling.locator(`[${CHAT_INPUT}]`)).toBeFocused();
    expect(await sibling.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(1);
    expect(await sibling.evaluate(() => window.__app.lastPairingCode?.()))
      .toBe('FRESH123');
    expect(await page.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(1);
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Reconnected');
    await expect(sibling.locator(`[${CONNECTION_BANNER}]`))
      .toContainText('Reconnected. Your Chat draft is ready where you left it.');
    await expect(sibling.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('This browser is paired');
    expect(siblingErrors).toHaveLength(0);
  } finally {
    await sibling.close();
    await page.evaluate(
      (keys) => keys.forEach((key) => window.localStorage.removeItem(key)),
      [
        MULTI_TAB_PAIR_STORAGE_KEY,
        MULTI_TAB_TRANSITION_STAGE_KEY,
        MULTI_TAB_TRANSITION_RELEASE_KEY,
      ],
    );
  }
});

test('simultaneous safe takeovers choose one visible winner and converge every tab', async ({
  page,
  context,
}) => {
  await page.evaluate(
    ({ pairKey, stageKey, releaseKey, pair }) => {
      window.localStorage.setItem(pairKey, JSON.stringify(pair));
      window.localStorage.removeItem(stageKey);
      window.localStorage.removeItem(releaseKey);
    },
    {
      pairKey: MULTI_TAB_PAIR_STORAGE_KEY,
      stageKey: MULTI_TAB_TRANSITION_STAGE_KEY,
      releaseKey: MULTI_TAB_TRANSITION_RELEASE_KEY,
      pair: {
        server_url: 'wss://alice.recued.cloud:8443/ws',
        server_public_key: HARNESS_SERVER_PUBLIC_KEY,
        webclient_token: {
          token_id: 'tok-simultaneous-original',
          ciphertext_b64: 'ciphertext-original',
          iv_b64: 'iv-original',
          issued_at: 1_700_000_000,
        },
        pair_metadata: {
          paired_at: 1_700_000_000,
          server_passport_fingerprint: 'fp-original',
          server_handle_at_pair: 'alice',
          instance_id: 'browser-simultaneous-original',
        },
        cert_pin_state: null,
      },
    },
  );
  const firstErrors: Error[] = [];
  const secondErrors: Error[] = [];
  const first = await context.newPage();
  const second = await context.newPage();
  first.on('pageerror', (error) => firstErrors.push(error));
  second.on('pageerror', (error) => secondErrors.push(error));
  const sourceUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&fail_pair_once=1&takeover_delay_ms=700&chat=session&keep=source%20simultaneous#connections`;
  const firstUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&takeover_delay_ms=700&hold_pair_response=1&chat=session&keep=first%20contender#chat/session/chat_1`;
  const secondUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&takeover_delay_ms=700&hold_pair_response=1&chat=session&keep=second%20contender#chat/session/chat_1`;

  try {
    await Promise.all([
      page.goto(sourceUrl),
      first.goto(firstUrl),
      second.goto(secondUrl),
    ]);
    await Promise.all([
      page.waitForFunction(() => window.__app?.ready === true),
      first.waitForFunction(() => window.__app?.ready === true),
      second.waitForFunction(() => window.__app?.ready === true),
    ]);
    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      first.waitForFunction(() => window.__app.activeRoute() === 'chat'),
      second.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);

    const firstDraft = 'Keep the first contender draft exactly here.';
    const secondDraft = 'Keep the second contender draft exactly here.';
    await first.locator(`[${CHAT_INPUT}]`).fill(firstDraft);
    await second.locator(`[${CHAT_INPUT}]`).fill(secondDraft);
    await page.evaluate(() => window.__app.forceReauth());

    const sourceForm = page.getByRole('form', {
      name: 'Reconnect this browser',
    });
    const firstForm = first.getByRole('form', {
      name: 'Reconnect this browser',
    });
    const secondForm = second.getByRole('form', {
      name: 'Reconnect this browser',
    });
    // Mounted sessions reconcile credentials on tab activation as well as
    // cross-tab hints. Visit each real tab before using its reconnect controls.
    for (const [tab, form] of [[page, sourceForm], [first, firstForm], [second, secondForm]] as const) {
      await tab.bringToFront();
      // Drive the focus reconciliation used by restored/background tabs;
      // activating a headless WebKit view alone may not dispatch this event.
      await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(form).toBeVisible();
    }

    const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
    await Promise.all([
      sourceForm.locator('#webclient-pair-code-input-recovery-0')
        .fill(recoveryKey),
      firstForm.locator('#webclient-pair-code-input-recovery-0')
        .fill(recoveryKey),
      secondForm.locator('#webclient-pair-code-input-recovery-0')
        .fill(recoveryKey),
    ]);
    await Promise.all([
      sourceForm.locator('#webclient-pair-code-input-code')
        .fill('SOURCE-SIMULTANEOUS'),
      firstForm.locator('#webclient-pair-code-input-code')
        .fill('STALE-FIRST'),
      secondForm.locator('#webclient-pair-code-input-code')
        .fill('STALE-SECOND'),
    ]);
    await sourceForm.getByRole('button', {
      name: 'Reconnect this browser',
    }).click();
    await expect(sourceForm.locator(
      `[${PAIR_INTERRUPTED_NOTICE}][data-local-finalize-retry]`,
    )).toContainText('Server pairing is complete');
    expect(await page.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(1);
    expect(await page.evaluate(() => window.__app.lastPairingCode?.()))
      .toBe('SOURCE-SIMULTANEOUS');

    const firstNotice = firstForm.locator(`[${PAIR_INTERRUPTED_NOTICE}]`);
    const secondNotice = secondForm.locator(`[${PAIR_INTERRUPTED_NOTICE}]`);
    await Promise.all([
      expect(firstNotice).toHaveAttribute(PAIR_TAKEOVER_READY, ''),
      expect(secondNotice).toHaveAttribute(PAIR_TAKEOVER_READY, ''),
    ]);
    await Promise.all([
      firstForm.locator('#webclient-pair-code-input-code')
        .fill('FRESH-FIRST'),
      secondForm.locator('#webclient-pair-code-input-code')
        .fill('FRESH-SECOND'),
    ]);
    const firstTakeover = firstForm.getByRole('button', {
      name: 'Reconnect in this tab',
    });
    const secondTakeover = secondForm.getByRole('button', {
      name: 'Reconnect in this tab',
    });
    await Promise.all([firstTakeover.press('Enter'), secondTakeover.press('Enter')]);

    await expect.poll(async () => {
      const [firstCount, secondCount] = await Promise.all([
        first.evaluate(() => window.__app.pairSubmitCount?.() ?? 0),
        second.evaluate(() => window.__app.pairSubmitCount?.() ?? 0),
      ]);
      return firstCount + secondCount;
    }).toBe(1);
    const [firstCount, secondCount] = await Promise.all([
      first.evaluate(() => window.__app.pairSubmitCount?.() ?? 0),
      second.evaluate(() => window.__app.pairSubmitCount?.() ?? 0),
    ]);
    const firstWon = firstCount === 1;
    expect([firstCount, secondCount].sort()).toEqual([0, 1]);
    const winner = firstWon ? first : second;
    const loser = firstWon ? second : first;
    const winnerForm = firstWon ? firstForm : secondForm;
    const loserForm = firstWon ? secondForm : firstForm;
    const winnerNotice = firstWon ? firstNotice : secondNotice;
    const loserNotice = firstWon ? secondNotice : firstNotice;
    const winnerCode = firstWon ? 'FRESH-FIRST' : 'FRESH-SECOND';

    await expect(winnerForm).toHaveAttribute('aria-busy', 'true');
    await expect(winnerNotice).toHaveAttribute(PAIR_TAKEOVER_OWNER, '');
    await expect(winnerNotice).toContainText('This tab is reconnecting');
    await expect(winnerNotice).toContainText(
      'If it works, your other tabs will use the same sign-in without sending their pairing codes',
    );
    const winnerProgress = winnerForm.getByRole('button', {
      name: 'Reconnecting from this tab…',
    });
    await expect(winnerProgress).toBeDisabled();
    await expect(winnerProgress).toBeFocused();
    await expect(loserForm).toHaveAttribute('aria-busy', 'true');
    await expect(loserNotice).not.toHaveAttribute(PAIR_TAKEOVER_OWNER, '');
    await expect(loserNotice).toContainText('Picking one tab');
    await expect(loserNotice).toContainText(
      'comes back by itself and never sends its pairing code',
    );
    const loserProgress = loserForm.getByRole('button', {
      name: 'Picking one tab…',
    });
    await expect(loserProgress).toBeDisabled();
    await expect(loserProgress).toBeFocused();
    expect(await winner.evaluate(() => window.__app.pendingPairResponses?.())).toBe(1);
    expect(await winner.evaluate(() => window.__app.releasePairResponses?.())).toBe(1);

    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      first.waitForFunction(() => window.__app.activeRoute() === 'chat'),
      second.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);

    await expect(page).toHaveURL(sourceUrl);
    await expect(first).toHaveURL(firstUrl);
    await expect(second).toHaveURL(secondUrl);
    await expect(sourceForm).toHaveCount(0);
    await expect(firstForm).toHaveCount(0);
    await expect(secondForm).toHaveCount(0);
    await expect(first.locator(`[${CHAT_INPUT}]`)).toHaveValue(firstDraft);
    await expect(second.locator(`[${CHAT_INPUT}]`)).toHaveValue(secondDraft);
    await expect(first.locator(`[${CHAT_INPUT}]`)).toBeFocused();
    await expect(second.locator(`[${CHAT_INPUT}]`)).toBeFocused();
    expect(await winner.evaluate(() => window.__app.lastPairingCode?.()))
      .toBe(winnerCode);
    expect(await loser.evaluate(() => window.__app.lastPairingCode?.()))
      .toBeNull();
    expect(
      await winner.evaluate(() => window.__app.pairSubmitCount?.() ?? 0)
      + await loser.evaluate(() => window.__app.pairSubmitCount?.() ?? 0),
    ).toBe(1);
    await expect(winner.locator(`[${CONNECTION_BANNER}]`)).toContainText(
      'Reconnected. Your Chat draft is ready where you left it.',
    );
    await expect(loser.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Reconnected');
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Reconnected');
    for (const tab of [page, first, second]) {
      await expect(tab.locator(`[${CONNECTION_BANNER}]`))
        .not.toContainText('This browser is paired');
    }
    expect(firstErrors).toHaveLength(0);
    expect(secondErrors).toHaveLength(0);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await page.evaluate(
      (keys) => keys.forEach((key) => window.localStorage.removeItem(key)),
      [
        MULTI_TAB_PAIR_STORAGE_KEY,
        MULTI_TAB_TRANSITION_STAGE_KEY,
        MULTI_TAB_TRANSITION_RELEASE_KEY,
      ],
    );
  }
});

test('a failed takeover owner yields its exact retry to the queued successor', async ({
  page,
  context,
}) => {
  await page.evaluate(
    ({ pairKey, stageKey, releaseKey, requestKey, pair }) => {
      window.localStorage.setItem(pairKey, JSON.stringify(pair));
      window.localStorage.removeItem(stageKey);
      window.localStorage.removeItem(releaseKey);
      window.localStorage.removeItem(requestKey);
    },
    {
      pairKey: MULTI_TAB_PAIR_STORAGE_KEY,
      stageKey: MULTI_TAB_TRANSITION_STAGE_KEY,
      releaseKey: MULTI_TAB_TRANSITION_RELEASE_KEY,
      requestKey: MULTI_TAB_TAKEOVER_REQUEST_COUNT_KEY,
      pair: {
        server_url: 'wss://alice.recued.cloud:8443/ws',
        server_public_key: HARNESS_SERVER_PUBLIC_KEY,
        webclient_token: {
          token_id: 'tok-succession-original',
          ciphertext_b64: 'ciphertext-original',
          iv_b64: 'iv-original',
          issued_at: 1_700_000_000,
        },
        pair_metadata: {
          paired_at: 1_700_000_000,
          server_passport_fingerprint: 'fp-original',
          server_handle_at_pair: 'alice',
          instance_id: 'browser-succession-original',
        },
        cert_pin_state: null,
      },
    },
  );
  const firstErrors: Error[] = [];
  const secondErrors: Error[] = [];
  const first = await context.newPage();
  const second = await context.newPage();
  first.on('pageerror', (error) => firstErrors.push(error));
  second.on('pageerror', (error) => secondErrors.push(error));
  const sourceUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&fail_pair_once=1&takeover_delay_ms=700&chat=session&keep=source%20succession#connections`;
  const firstUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&takeover_delay_ms=700&hold_pair_response=1&fail_first_takeover_globally=1&chat=session&keep=first%20succession#chat/session/chat_1`;
  const secondUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&takeover_delay_ms=700&hold_pair_response=1&fail_first_takeover_globally=1&chat=session&keep=second%20succession#chat/session/chat_1`;

  try {
    await Promise.all([
      page.goto(sourceUrl),
      first.goto(firstUrl),
      second.goto(secondUrl),
    ]);
    await Promise.all([
      page.waitForFunction(() => window.__app?.ready === true),
      first.waitForFunction(() => window.__app?.ready === true),
      second.waitForFunction(() => window.__app?.ready === true),
    ]);
    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      first.waitForFunction(() => window.__app.activeRoute() === 'chat'),
      second.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);

    const firstDraft = 'Keep the failed owner draft for its exact return.';
    const secondDraft = 'Keep the queued successor draft for its exact return.';
    await first.locator(`[${CHAT_INPUT}]`).fill(firstDraft);
    await second.locator(`[${CHAT_INPUT}]`).fill(secondDraft);
    await page.evaluate(() => window.__app.forceReauth());

    const sourceForm = page.getByRole('form', {
      name: 'Reconnect this browser',
    });
    const firstForm = first.getByRole('form', {
      name: 'Reconnect this browser',
    });
    const secondForm = second.getByRole('form', {
      name: 'Reconnect this browser',
    });
    // Mounted sessions reconcile credentials on tab activation as well as
    // cross-tab hints. Visit each real tab before using its reconnect controls.
    for (const [tab, form] of [[page, sourceForm], [first, firstForm], [second, secondForm]] as const) {
      await tab.bringToFront();
      // Drive the focus reconciliation used by restored/background tabs;
      // activating a headless WebKit view alone may not dispatch this event.
      await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(form).toBeVisible();
    }

    const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
    await Promise.all([
      sourceForm.locator('#webclient-pair-code-input-recovery-0')
        .fill(recoveryKey),
      firstForm.locator('#webclient-pair-code-input-recovery-0')
        .fill(recoveryKey),
      secondForm.locator('#webclient-pair-code-input-recovery-0')
        .fill(recoveryKey),
    ]);
    await sourceForm.locator('#webclient-pair-code-input-code')
      .fill('SOURCE-SUCCESSION');
    await sourceForm.getByRole('button', {
      name: 'Reconnect this browser',
    }).click();
    await expect(sourceForm.locator(
      `[${PAIR_INTERRUPTED_NOTICE}][data-local-finalize-retry]`,
    )).toContainText('Server pairing is complete');

    const firstNotice = firstForm.locator(`[${PAIR_INTERRUPTED_NOTICE}]`);
    const secondNotice = secondForm.locator(`[${PAIR_INTERRUPTED_NOTICE}]`);
    await Promise.all([
      expect(firstNotice).toHaveAttribute(PAIR_TAKEOVER_READY, ''),
      expect(secondNotice).toHaveAttribute(PAIR_TAKEOVER_READY, ''),
    ]);
    await Promise.all([
      firstForm.locator('#webclient-pair-code-input-code')
        .fill('FIRST-SUCCESSION'),
      secondForm.locator('#webclient-pair-code-input-code')
        .fill('SECOND-SUCCESSION'),
    ]);
    await Promise.all([
      firstForm.getByRole('button', { name: 'Reconnect in this tab' }).press('Enter'),
      secondForm.getByRole('button', { name: 'Reconnect in this tab' }).press('Enter'),
    ]);

    await expect.poll(async () => {
      const [firstCount, secondCount] = await Promise.all([
        first.evaluate(() => window.__app.pairSubmitCount?.() ?? 0),
        second.evaluate(() => window.__app.pairSubmitCount?.() ?? 0),
      ]);
      return firstCount + secondCount;
    }).toBe(1);
    const [firstCount, secondCount] = await Promise.all([
      first.evaluate(() => window.__app.pairSubmitCount?.() ?? 0),
      second.evaluate(() => window.__app.pairSubmitCount?.() ?? 0),
    ]);
    const firstOwnedThenFailed = firstCount === 1;
    expect([firstCount, secondCount].sort()).toEqual([0, 1]);
    const failedOwner = firstOwnedThenFailed ? first : second;
    const successor = firstOwnedThenFailed ? second : first;
    const failedForm = firstOwnedThenFailed ? firstForm : secondForm;
    const successorForm = firstOwnedThenFailed ? secondForm : firstForm;
    const failedNotice = firstOwnedThenFailed ? firstNotice : secondNotice;
    const successorNotice = firstOwnedThenFailed ? secondNotice : firstNotice;
    const failedCode = firstOwnedThenFailed
      ? 'FIRST-SUCCESSION'
      : 'SECOND-SUCCESSION';
    const successorCode = firstOwnedThenFailed
      ? 'SECOND-SUCCESSION'
      : 'FIRST-SUCCESSION';

    await expect(successorNotice).toContainText('Picking one tab');
    await expect(successorForm).toHaveAttribute('aria-busy', 'true');
    // The first server reply fails only after both contenders are queued.
    expect(await failedOwner.evaluate(() => window.__app.pendingPairResponses?.())).toBe(1);
    expect(await failedOwner.evaluate(() => window.__app.releasePairResponses?.())).toBe(1);
    await expect(failedNotice).toHaveAttribute(PAIR_SUCCESSION, '', {
      timeout: 8_000,
    });
    await expect(failedNotice).toContainText('Another tab is continuing');
    await expect(failedNotice).toContainText(
      'will not send or save the same access twice',
    );
    await expect(failedForm).toHaveAttribute('aria-busy', 'true');
    await expect(failedForm.locator('[data-error]')).toHaveCount(0);
    const yieldedAction = failedForm.getByRole('button', {
      name: 'Continuing in another tab…',
    });
    await expect(yieldedAction).toBeDisabled();
    await expect(yieldedAction).toBeFocused();

    const sourceYieldNotice = sourceForm.locator(
      `[${PAIR_INTERRUPTED_NOTICE}]`,
    );
    await expect(sourceYieldNotice).toHaveAttribute(PAIR_SUCCESSION, '');
    await expect(sourceYieldNotice).toContainText(
      'Another tab is continuing',
    );
    await expect(sourceForm.locator('[data-local-finalize-retry]'))
      .toHaveCount(0);
    await expect(sourceForm.getByRole('button', {
      name: 'Continuing in another tab…',
    })).toBeDisabled();

    await expect(successorNotice).toHaveAttribute(
      PAIR_TAKEOVER_OWNER,
      '',
    );
    await expect(successorNotice).toContainText('This tab is reconnecting');
    await expect(successorForm.getByRole('button', {
      name: 'Reconnecting from this tab…',
    })).toBeFocused();
    expect(await failedOwner.evaluate(
      () => window.__app.lastPairingCode?.(),
    )).toBe(failedCode);
    expect(await successor.evaluate(
      () => window.__app.lastPairingCode?.(),
    )).toBe(successorCode);
    expect(
      await failedOwner.evaluate(() => window.__app.pairSubmitCount?.() ?? 0)
      + await successor.evaluate(() => window.__app.pairSubmitCount?.() ?? 0),
    ).toBe(2);
    expect(await successor.evaluate(() => window.__app.pendingPairResponses?.())).toBe(1);
    expect(await successor.evaluate(() => window.__app.releasePairResponses?.())).toBe(1);

    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      first.waitForFunction(() => window.__app.activeRoute() === 'chat'),
      second.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);
    await expect(page).toHaveURL(sourceUrl);
    await expect(first).toHaveURL(firstUrl);
    await expect(second).toHaveURL(secondUrl);
    await expect(sourceForm).toHaveCount(0);
    await expect(firstForm).toHaveCount(0);
    await expect(secondForm).toHaveCount(0);
    await expect(first.locator(`[${CHAT_INPUT}]`)).toHaveValue(firstDraft);
    await expect(second.locator(`[${CHAT_INPUT}]`)).toHaveValue(secondDraft);
    await expect(first.locator(`[${CHAT_INPUT}]`)).toBeFocused();
    await expect(second.locator(`[${CHAT_INPUT}]`)).toBeFocused();
    await expect(successor.locator(`[${CONNECTION_BANNER}]`)).toContainText(
      'Reconnected. Your Chat draft is ready where you left it.',
    );
    await expect(failedOwner.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Reconnected');
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Reconnected');
    for (const tab of [page, first, second]) {
      await expect(tab.locator(`[${CONNECTION_BANNER}]`))
        .not.toContainText('This browser is paired');
    }
    expect(firstErrors).toHaveLength(0);
    expect(secondErrors).toHaveLength(0);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await page.evaluate(
      (keys) => keys.forEach((key) => window.localStorage.removeItem(key)),
      [
        MULTI_TAB_PAIR_STORAGE_KEY,
        MULTI_TAB_TRANSITION_STAGE_KEY,
        MULTI_TAB_TRANSITION_RELEASE_KEY,
        MULTI_TAB_TAKEOVER_REQUEST_COUNT_KEY,
      ],
    );
  }
});

test('a lost recovery owner hands one survivor the exact retry', async ({
  page,
  context,
}) => {
  await page.evaluate(
    ({ pairKey, stageKey, releaseKey, requestKey, pair }) => {
      window.localStorage.setItem(pairKey, JSON.stringify(pair));
      window.localStorage.removeItem(stageKey);
      window.localStorage.removeItem(releaseKey);
      window.localStorage.removeItem(requestKey);
    },
    {
      pairKey: MULTI_TAB_PAIR_STORAGE_KEY,
      stageKey: MULTI_TAB_TRANSITION_STAGE_KEY,
      releaseKey: MULTI_TAB_TRANSITION_RELEASE_KEY,
      requestKey: MULTI_TAB_TAKEOVER_REQUEST_COUNT_KEY,
      pair: {
        server_url: 'wss://alice.recued.cloud:8443/ws',
        server_public_key: HARNESS_SERVER_PUBLIC_KEY,
        webclient_token: {
          token_id: 'tok-recovery-owner-original',
          ciphertext_b64: 'ciphertext-original',
          iv_b64: 'iv-original',
          issued_at: 1_700_000_000,
        },
        pair_metadata: {
          paired_at: 1_700_000_000,
          server_passport_fingerprint: 'fp-original',
          server_handle_at_pair: 'alice',
          instance_id: 'browser-recovery-owner-original',
        },
        cert_pin_state: null,
      },
    },
  );
  const firstErrors: Error[] = [];
  const secondErrors: Error[] = [];
  const first = await context.newPage();
  const second = await context.newPage();
  first.on('pageerror', (error) => firstErrors.push(error));
  second.on('pageerror', (error) => secondErrors.push(error));
  const sourceUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&fail_pair_once=1&takeover_delay_ms=700&recovery_owner_delay_ms=700&recovery_owner_heartbeat_ms=150&chat=session&keep=source%20owner#connections`;
  const firstUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&takeover_delay_ms=700&recovery_owner_delay_ms=700&recovery_owner_heartbeat_ms=150&pair_response_delay_ms=1200&fail_takeover_attempts=2&chat=session&keep=first%20owner#chat/session/chat_1`;
  const secondUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&takeover_delay_ms=700&recovery_owner_delay_ms=700&recovery_owner_heartbeat_ms=150&pair_response_delay_ms=1200&fail_takeover_attempts=2&chat=session&keep=second%20owner#chat/session/chat_1`;

  try {
    await Promise.all([
      page.goto(sourceUrl),
      first.goto(firstUrl),
      second.goto(secondUrl),
    ]);
    await Promise.all([
      page.waitForFunction(() => window.__app?.ready === true),
      first.waitForFunction(() => window.__app?.ready === true),
      second.waitForFunction(() => window.__app?.ready === true),
    ]);
    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      first.waitForFunction(() => window.__app.activeRoute() === 'chat'),
      second.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);

    const firstDraft = 'Keep the first failed contender draft.';
    const secondDraft = 'Keep the final recovery owner draft.';
    await first.locator(`[${CHAT_INPUT}]`).fill(firstDraft);
    await second.locator(`[${CHAT_INPUT}]`).fill(secondDraft);
    await page.evaluate(() => window.__app.forceReauth());

    const sourceForm = page.getByRole('form', {
      name: 'Reconnect this browser',
    });
    const firstForm = first.getByRole('form', {
      name: 'Reconnect this browser',
    });
    const secondForm = second.getByRole('form', {
      name: 'Reconnect this browser',
    });
    // Mounted sessions reconcile credentials on tab activation as well as
    // cross-tab hints. Visit each real tab before using its reconnect controls.
    for (const [tab, form] of [[page, sourceForm], [first, firstForm], [second, secondForm]] as const) {
      await tab.bringToFront();
      // Drive the focus reconciliation used by restored/background tabs;
      // activating a headless WebKit view alone may not dispatch this event.
      await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(form).toBeVisible();
    }

    const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
    await Promise.all([
      sourceForm.locator('#webclient-pair-code-input-recovery-0')
        .fill(recoveryKey),
      firstForm.locator('#webclient-pair-code-input-recovery-0')
        .fill(recoveryKey),
      secondForm.locator('#webclient-pair-code-input-recovery-0')
        .fill(recoveryKey),
    ]);
    await sourceForm.locator('#webclient-pair-code-input-code')
      .fill('SOURCE-OWNER');
    await sourceForm.getByRole('button', {
      name: 'Reconnect this browser',
    }).click();
    await expect(sourceForm.locator(
      `[${PAIR_INTERRUPTED_NOTICE}][data-local-finalize-retry]`,
    )).toContainText('Server pairing is complete');

    const firstNotice = firstForm.locator(`[${PAIR_INTERRUPTED_NOTICE}]`);
    const secondNotice = secondForm.locator(`[${PAIR_INTERRUPTED_NOTICE}]`);
    await Promise.all([
      expect(firstNotice).toHaveAttribute(PAIR_TAKEOVER_READY, ''),
      expect(secondNotice).toHaveAttribute(PAIR_TAKEOVER_READY, ''),
    ]);
    await Promise.all([
      firstForm.locator('#webclient-pair-code-input-code')
        .fill('FIRST-FAILED'),
      secondForm.locator('#webclient-pair-code-input-code')
        .fill('SECOND-FAILED'),
    ]);
    await Promise.all([
      firstForm.getByRole('button', { name: 'Reconnect in this tab' }).press('Enter'),
      secondForm.getByRole('button', { name: 'Reconnect in this tab' }).press('Enter'),
    ]);

    const sourceNotice = sourceForm.locator(`[${PAIR_INTERRUPTED_NOTICE}]`);
    await expect.poll(async () => {
      const [firstCount, secondCount, sourceOwns, firstOwns, secondOwns] =
        await Promise.all([
          first.evaluate(() => window.__app.pairSubmitCount?.() ?? 0),
          second.evaluate(() => window.__app.pairSubmitCount?.() ?? 0),
          sourceNotice.getAttribute(PAIR_RECOVERY_OWNER),
          firstNotice.getAttribute(PAIR_RECOVERY_OWNER),
          secondNotice.getAttribute(PAIR_RECOVERY_OWNER),
        ]);
      return {
        attempts: firstCount + secondCount,
        recoveryOwners: [sourceOwns, firstOwns, secondOwns]
          .filter((value) => value !== null).length,
      };
    }).toEqual({ attempts: 2, recoveryOwners: 1 });
    const firstIsRecoveryOwner =
      (await firstNotice.getAttribute(PAIR_RECOVERY_OWNER)) !== null;
    const secondIsRecoveryOwner =
      (await secondNotice.getAttribute(PAIR_RECOVERY_OWNER)) !== null;
    expect(
      [firstIsRecoveryOwner, secondIsRecoveryOwner].filter(Boolean),
    ).toHaveLength(1);
    const priorOwner = firstIsRecoveryOwner ? second : first;
    const recoveryOwner = firstIsRecoveryOwner ? first : second;
    const priorForm = firstIsRecoveryOwner ? secondForm : firstForm;
    const recoveryForm = firstIsRecoveryOwner ? firstForm : secondForm;
    const priorNotice = firstIsRecoveryOwner ? secondNotice : firstNotice;
    const recoveryNotice = firstIsRecoveryOwner ? firstNotice : secondNotice;

    await expect(recoveryNotice).toHaveAttribute(PAIR_RECOVERY_OWNER, '', {
      timeout: 7_000,
    });
    await expect(recoveryNotice).toContainText('This tab needs you');
    await expect(recoveryNotice).toContainText('only one to deal with');
    await expect(recoveryForm.locator(
      '[data-error="invalid_code"]',
    )).toBeVisible();
    const recoveryRetry = recoveryForm.getByRole('button', {
      name: 'Retry in this tab',
    });
    await expect(recoveryRetry).toBeEnabled();
    await expect(recoveryRetry).toBeFocused();

    await expect(priorNotice).toHaveAttribute(
      PAIR_RECOVERY_OWNER_ELSEWHERE,
      '',
    );
    await expect(priorNotice).toContainText(
      'Carry on in the tab that needs you',
    );
    await expect(priorForm.locator('[data-error="invalid_code"]'))
      .toHaveCount(0);
    await expect(priorForm.getByRole('button', {
      name: 'Waiting for recovery tab…',
    })).toBeDisabled();

    await expect(sourceNotice).toHaveAttribute(
      PAIR_RECOVERY_OWNER_ELSEWHERE,
      '',
    );
    await expect(sourceForm.locator('[data-local-finalize-retry]'))
      .toHaveCount(0);
    await expect(sourceForm.getByRole('button', {
      name: 'Waiting for recovery tab…',
    })).toBeDisabled();
    expect(
      await priorOwner.evaluate(() => window.__app.pairSubmitCount?.() ?? 0)
      + await recoveryOwner.evaluate(
        () => window.__app.pairSubmitCount?.() ?? 0,
      ),
    ).toBe(2);
    const survivorSubmitCountBefore =
      await page.evaluate(() => window.__app.pairSubmitCount?.() ?? 0)
      + await priorOwner.evaluate(
        () => window.__app.pairSubmitCount?.() ?? 0,
      );

    // Losing the only actionable tab must not make both survivors retryable.
    // The browser-held successor lease selects exactly one, while the other
    // keeps its exact route/draft and explains where recovery moved.
    await recoveryOwner.close();
    await expect.poll(async () => {
      const [sourceOwns, priorOwns, sourceWaits, priorWaits] =
        await Promise.all([
          sourceNotice.getAttribute(PAIR_RECOVERY_SUCCESSOR),
          priorNotice.getAttribute(PAIR_RECOVERY_SUCCESSOR),
          sourceNotice.getAttribute(PAIR_RECOVERY_SUCCESSOR_ELSEWHERE),
          priorNotice.getAttribute(PAIR_RECOVERY_SUCCESSOR_ELSEWHERE),
        ]);
      return {
        successors: [sourceOwns, priorOwns]
          .filter((value) => value !== null).length,
        passive: [sourceWaits, priorWaits]
          .filter((value) => value !== null).length,
      };
    }, { timeout: 7_000 }).toEqual({ successors: 1, passive: 1 });

    const sourceIsSuccessor =
      (await sourceNotice.getAttribute(PAIR_RECOVERY_SUCCESSOR)) !== null;
    const successorPage = sourceIsSuccessor ? page : priorOwner;
    const successorForm = sourceIsSuccessor ? sourceForm : priorForm;
    const successorNotice = sourceIsSuccessor ? sourceNotice : priorNotice;
    const passivePage = sourceIsSuccessor ? priorOwner : page;
    const passiveForm = sourceIsSuccessor ? priorForm : sourceForm;
    const passiveNotice = sourceIsSuccessor ? priorNotice : sourceNotice;
    const priorUrl = firstIsRecoveryOwner ? secondUrl : firstUrl;
    const priorDraft = firstIsRecoveryOwner ? secondDraft : firstDraft;

    await expect(successorNotice).toContainText('Recued moved to this tab');
    await expect(successorNotice).toContainText('picked this tab to carry on');
    if (sourceIsSuccessor) {
      await expect(successorNotice).toContainText(
        'will not ask to pair again',
      );
    }
    await expect(successorForm.locator('[data-error]')).toBeVisible();
    const successorAction = successorForm.getByRole('button', {
      name: sourceIsSuccessor
        ? 'Finish saving your sign-in'
        : 'Carry on here',
    });
    await expect(successorAction).toBeEnabled();
    await expect(successorAction).toBeFocused();

    await expect(passiveNotice).toContainText(
      'Another tab is carrying on',
    );
    await expect(passiveNotice).toContainText('stays paused');
    await expect(passiveForm.getByRole('button', {
      name: 'Waiting for recovery tab…',
    })).toBeDisabled();
    expect(
      await page.evaluate(() => window.__app.pairSubmitCount?.() ?? 0)
      + await priorOwner.evaluate(
        () => window.__app.pairSubmitCount?.() ?? 0,
      ),
    ).toBe(survivorSubmitCountBefore);

    if (!sourceIsSuccessor) {
      await successorForm.locator('#webclient-pair-code-input-code')
        .fill('SUCCESSOR-RETRY');
    }
    await successorAction.click();

    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      priorOwner.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);
    await expect(page).toHaveURL(sourceUrl);
    await expect(priorOwner).toHaveURL(priorUrl);
    await expect(sourceForm).toHaveCount(0);
    await expect(priorForm).toHaveCount(0);
    await expect(priorOwner.locator(`[${CHAT_INPUT}]`)).toHaveValue(priorDraft);
    await expect(priorOwner.locator(`[${CHAT_INPUT}]`)).toBeFocused();
    if (!sourceIsSuccessor) {
      expect(await successorPage.evaluate(
        () => window.__app.lastPairingCode?.(),
      )).toBe('SUCCESSOR-RETRY');
    }
    await expect(successorPage.locator(`[${CONNECTION_BANNER}]`))
      .toContainText('Reconnected.');
    await expect(passivePage.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Reconnected');
    expect(
      await page.evaluate(() => window.__app.pairSubmitCount?.() ?? 0)
      + await priorOwner.evaluate(
        () => window.__app.pairSubmitCount?.() ?? 0,
      ),
    ).toBe(survivorSubmitCountBefore + (sourceIsSuccessor ? 0 : 1));
    expect(firstErrors).toHaveLength(0);
    expect(secondErrors).toHaveLength(0);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await page.evaluate(
      (keys) => keys.forEach((key) => window.localStorage.removeItem(key)),
      [
        MULTI_TAB_PAIR_STORAGE_KEY,
        MULTI_TAB_TRANSITION_STAGE_KEY,
        MULTI_TAB_TRANSITION_RELEASE_KEY,
        MULTI_TAB_TAKEOVER_REQUEST_COUNT_KEY,
      ],
    );
  }
});

test('the last recovery document re-enters one clean reconnect on its exact route', async ({
  page,
}) => {
  await page.evaluate(
    ({ pairKey, pair }) => {
      window.localStorage.setItem(pairKey, JSON.stringify(pair));
    },
    {
      pairKey: MULTI_TAB_PAIR_STORAGE_KEY,
      pair: {
        server_url: 'wss://alice.recued.cloud:8443/ws',
        server_public_key: HARNESS_SERVER_PUBLIC_KEY,
        webclient_token: {
          token_id: 'tok-last-tab-original',
          ciphertext_b64: 'ciphertext-original',
          iv_b64: 'iv-original',
          issued_at: 1_700_000_000,
        },
        pair_metadata: {
          paired_at: 1_700_000_000,
          server_passport_fingerprint: 'fp-original',
          server_handle_at_pair: 'alice',
          instance_id: 'browser-last-tab-original',
        },
        cert_pin_state: null,
      },
    },
  );
  const exactUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&chat=session&keep=last%20recovery#chat/session/chat_1`;

  try {
    await page.goto(exactUrl);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
    await page.evaluate(() => window.__app.forceReauth());

    let form = page.getByRole('form', {
      name: 'Reconnect this browser',
    });
    await expect(form).toBeVisible();
    const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
    await form.locator('#webclient-pair-code-input-recovery-0')
      .fill(recoveryKey);
    await form.locator('#webclient-pair-code-input-code')
      .fill('STALE-IN-MEMORY');
    expect(await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      RECOVERY_REENTRY_SESSION_KEY,
    )).toBe('1');

    // Model the final recovery document disappearing after a stale external
    // handoff modified its address. Reload destroys every in-memory field;
    // the product marker carries no field or route data into the new document.
    await page.evaluate(() => {
      const [beforeHash, hash = ''] = window.location.href.split('#', 2);
      window.history.replaceState(
        window.history.state,
        '',
        `${beforeHash}&code=STALE-IN-ADDRESS&recued_pair_resume=same-origin${hash.length > 0 ? `#${hash}` : ''}`,
      );
    });
    await page.reload();
    await page.waitForFunction(() => window.__app?.ready === true);

    await expect(page).toHaveURL(exactUrl);
    form = page.getByRole('form', { name: 'Reconnect this browser' });
    await expect(form).toBeVisible();
    const reentryNotice = form.locator(`[${PAIR_REAUTH_NOTICE}]`);
    await expect(reentryNotice).toHaveAttribute('role', 'status');
    await expect(reentryNotice).toContainText('Carrying on in this tab');
    await expect(reentryNotice).toContainText(
      'You do not need to wait for it.',
    );
    await expect(reentryNotice).toContainText(
      'The page you were going back to is still chosen.',
    );
    await expect(reentryNotice).toContainText(
      'Your pairing details are not kept',
    );
    await expect(reentryNotice).toContainText(
      'Type any missing server address, pairing code, and recovery key again',
    );
    await expect(form.locator(`[${PAIR_INTERRUPTED_NOTICE}]`)).toHaveCount(0);
    await expect(form).not.toContainText('another tab');
    const serverUrl = form.locator('#webclient-pair-code-input-server-url');
    await expect(serverUrl).toHaveValue('');
    await expect(serverUrl).toHaveAttribute('autofocus', '');
    await expect(serverUrl).toBeFocused();
    const recoveryHelp = form.locator(`[${PAIR_RECOVERY_HELP}]`);
    await expect(recoveryHelp).not.toHaveAttribute('open', '');
    const recoveryHelpSummary = recoveryHelp.locator('summary');
    await expect(recoveryHelpSummary).toHaveText(
      'Need help finding these details?',
    );
    expect(await recoveryHelpSummary.evaluate(
      (summary) => summary.getBoundingClientRect().height,
    )).toBeGreaterThanOrEqual(44);
    await recoveryHelpSummary.focus();
    await expect(recoveryHelpSummary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(recoveryHelp).toHaveAttribute('open', '');
    await expect(recoveryHelp).toContainText('recued pair');
    await expect(recoveryHelp).toContainText(
      'an http://localhost address is only for reconnecting on that same computer',
    );
    await expect(recoveryHelp).toContainText(
      'does not save a readable copy of those words',
    );
    await expect(recoveryHelp).toContainText(
      'fresh pairing code cannot replace the key',
    );
    await expect(recoveryHelp).toContainText(
      'Stop here instead of generating a new one for this server.',
    );
    await expect(recoveryHelp).toContainText(
      'Never send the key through support, email, or Chat.',
    );
    await expect(recoveryHelp).toContainText(
      'ask where the recovery key was saved',
    );
    await expect(form.locator('#webclient-pair-code-input-code'))
      .toHaveValue('');
    await expect(form.locator('#webclient-pair-code-input-recovery-0'))
      .toHaveValue('');
    expect(await page.evaluate(() => window.__app.pairSubmitCount?.() ?? 0))
      .toBe(0);
    expect(await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      RECOVERY_REENTRY_SESSION_KEY,
    )).toBe('1');

    await page.setViewportSize({ width: 280, height: 653 });
    const narrowLayout = await form.evaluate((surface) => ({
      overflow: surface.scrollWidth <= surface.clientWidth,
      actionHeight: surface.querySelector('button')?.getBoundingClientRect()
        .height ?? 0,
    }));
    expect(narrowLayout.overflow).toBe(true);
    expect(narrowLayout.actionHeight).toBeGreaterThanOrEqual(44);

    await serverUrl.fill('https://alice.recued.cloud:8443');
    await form.locator('#webclient-pair-code-input-recovery-0')
      .fill(recoveryKey);
    await expect(recoveryHelp).toHaveAttribute('open', '');
    await form.locator('#webclient-pair-code-input-code')
      .fill('FRESH-LAST-TAB');
    await form.getByRole('button', {
      name: 'Reconnect this browser',
    }).click();

    await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
    await expect(page).toHaveURL(exactUrl);
    await expect(form).toHaveCount(0);
    await expect(page.locator(`[${CONNECTION_BANNER}]`)).toContainText(
      'Reconnected. You’re back where you left off.',
    );
    expect(await page.evaluate(() => window.__app.lastPairingCode?.()))
      .toBe('FRESH-LAST-TAB');
    expect(await page.evaluate(() => window.__app.pairSubmitCount?.() ?? 0))
      .toBe(1);
    expect(await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      RECOVERY_REENTRY_SESSION_KEY,
    )).toBeNull();

    // Model a second, previously closed recovery document being restored
    // after this tab made access durable. Its stale constant marker must lose
    // to the healthy pair, land silently, and retire without replaying either
    // the reconnect receipt or the form.
    await page.evaluate(
      (key) => window.sessionStorage.setItem(key, '1'),
      RECOVERY_REENTRY_SESSION_KEY,
    );
    await page.reload();
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
    await expect(page).toHaveURL(exactUrl);
    await expect(page.getByRole('form', {
      name: 'Reconnect this browser',
    })).toHaveCount(0);
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Reconnected');
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('This browser is paired');
    expect(await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      RECOVERY_REENTRY_SESSION_KEY,
    )).toBeNull();
  } finally {
    await page.evaluate(
      ({ pairKey, markerKey }) => {
        window.localStorage.removeItem(pairKey);
        window.sessionStorage.removeItem(markerKey);
      },
      {
        pairKey: MULTI_TAB_PAIR_STORAGE_KEY,
        markerKey: RECOVERY_REENTRY_SESSION_KEY,
      },
    );
  }
});

test('a third tab arriving and reloading mid-pair waits for one clean exact-route landing', async ({
  page,
  context,
}) => {
  await page.evaluate(
    ({ pairKey, stageKey, releaseKey, pair }) => {
      window.localStorage.setItem(pairKey, JSON.stringify(pair));
      window.localStorage.removeItem(stageKey);
      window.localStorage.removeItem(releaseKey);
    },
    {
      pairKey: MULTI_TAB_PAIR_STORAGE_KEY,
      stageKey: MULTI_TAB_TRANSITION_STAGE_KEY,
      releaseKey: MULTI_TAB_TRANSITION_RELEASE_KEY,
      pair: {
        server_url: 'wss://alice.recued.cloud:8443/ws',
        server_public_key: HARNESS_SERVER_PUBLIC_KEY,
        webclient_token: {
          token_id: 'tok-transition-original',
          ciphertext_b64: 'ciphertext-original',
          iv_b64: 'iv-original',
          issued_at: 1_700_000_000,
        },
        pair_metadata: {
          paired_at: 1_700_000_000,
          server_passport_fingerprint: 'fp-original',
          server_handle_at_pair: 'alice',
          instance_id: 'browser-transition-original',
        },
        cert_pin_state: null,
      },
    },
  );
  const siblingErrors: Error[] = [];
  const arrivalErrors: Error[] = [];
  const sibling = await context.newPage();
  const arrival = await context.newPage();
  sibling.on('pageerror', (error) => siblingErrors.push(error));
  arrival.on('pageerror', (error) => arrivalErrors.push(error));
  const sourceUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&pause_pair=1&chat=session&keep=source%20tab#connections`;
  const siblingUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&pause_pair=1&chat=session&keep=sibling%20tab#chat/session/chat_1`;
  const arrivalUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&pause_pair=1&chat=session&keep=arrival%20tab&keep=arrival+two#chat/session/chat_1`;

  try {
    await Promise.all([page.goto(sourceUrl), sibling.goto(siblingUrl)]);
    await Promise.all([
      page.waitForFunction(() => window.__app?.ready === true),
      sibling.waitForFunction(() => window.__app?.ready === true),
    ]);
    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      sibling.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);

    const draft = 'Keep this diagnosis while another tab reconnects.';
    const siblingInput = sibling.locator(`[${CHAT_INPUT}]`);
    await siblingInput.fill(draft);
    await page.evaluate(() => window.__app.forceReauth());

    const sourceForm = page.getByRole('form', {
      name: 'Reconnect this browser',
    });
    const siblingForm = sibling.getByRole('form', {
      name: 'Reconnect this browser',
    });
    await expect(sourceForm).toBeVisible();
    await expect(siblingForm).toBeVisible();

    const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
    await sourceForm.locator(
      '#webclient-pair-code-input-recovery-0',
    ).fill(recoveryKey);
    await sourceForm.getByRole('button', {
      name: 'Reconnect this browser',
    }).click();
    await expect.poll(() => page.evaluate(
      (key) => window.localStorage.getItem(key),
      MULTI_TAB_TRANSITION_STAGE_KEY,
    )).toBe('pair_metadata');

    await arrival.setViewportSize({ width: 280, height: 653 });
    await arrival.goto(arrivalUrl);
    await arrival.waitForTimeout(300);
    const arrivalCheck = arrival.locator('#webclient-boot-splash-message');
    await expect(arrivalCheck).toHaveText('Checking your saved sign-in…');
    await expect(arrivalCheck).toHaveAttribute('role', 'status');
    await expect(arrivalCheck).toHaveAttribute('aria-live', 'polite');
    await expect(arrival.locator('#webclient-pair-code-input-form'))
      .toHaveCount(0);
    await expect(arrival.locator(`[${COLD_START_CREDENTIAL_REPAIR}]`))
      .toHaveCount(0);
    await expect(arrival.locator(`[${SHELL_HOST}]`)).toHaveCount(0);
    expect(await arrival.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }))).toEqual({
      documentWidth: 280,
      viewportWidth: 280,
    });
    await arrival.screenshot({
      path: test.info().outputPath(`full-app-mid-transition-wait-mobile.png`),
      fullPage: true,
    });

    // A real reload while the source still owns the transition lock must land
    // on the same neutral check, never a stale pair/corruption surface.
    await arrival.reload();
    await arrival.waitForTimeout(300);
    await expect(arrival).toHaveURL(arrivalUrl);
    await expect(arrivalCheck).toHaveText('Checking your saved sign-in…');
    await expect(arrivalCheck).toHaveAttribute('role', 'status');
    await expect(arrival.locator('#webclient-pair-code-input-form'))
      .toHaveCount(0);
    await expect(arrival.locator(`[${COLD_START_CREDENTIAL_REPAIR}]`))
      .toHaveCount(0);

    await page.evaluate(
      (key) => window.localStorage.setItem(key, '1'),
      MULTI_TAB_TRANSITION_RELEASE_KEY,
    );
    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      sibling.waitForFunction(() => window.__app.activeRoute() === 'chat'),
      arrival.waitForFunction(() => window.__app?.ready === true),
    ]);
    await arrival.waitForFunction(() => window.__app.activeRoute() === 'chat');

    await expect(page).toHaveURL(sourceUrl);
    await expect(sibling).toHaveURL(siblingUrl);
    await expect(arrival).toHaveURL(arrivalUrl);
    await expect(sourceForm).toHaveCount(0);
    await expect(siblingForm).toHaveCount(0);
    await expect(arrival.locator('#webclient-pair-code-input-form'))
      .toHaveCount(0);
    await expect(arrival.locator(`[${COLD_START_CREDENTIAL_REPAIR}]`))
      .toHaveCount(0);
    await expect(siblingInput).toHaveValue(draft);
    await expect(siblingInput).toBeFocused();
    await expect(arrival.locator(`[${CHAT_SESSION_ROW}="chat_1"]`))
      .toHaveAttribute('aria-current', 'page');
    await expect(arrival.locator(`[${CONNECTION_BANNER}]`))
      .toHaveAttribute('data-state', 'ok');
    await expect(arrival.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Reconnected');
    await expect(arrival.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('This browser is paired');
    await expect(sibling.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Reconnected');
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .toHaveAttribute('data-state', 'restored');
    expect(await page.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(1);
    expect(await sibling.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(0);
    expect(await arrival.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(0);

    expect(await arrival.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }))).toEqual({
      documentWidth: 280,
      viewportWidth: 280,
    });
    await arrival.screenshot({
      path: test.info().outputPath(`full-app-mid-transition-arrival-mobile.png`),
      fullPage: true,
    });
    expect(siblingErrors).toHaveLength(0);
    expect(arrivalErrors).toHaveLength(0);
  } finally {
    await Promise.all([sibling.close(), arrival.close()]);
    await page.evaluate(
      ({ pairKey, stageKey, releaseKey }) => {
        window.localStorage.removeItem(pairKey);
        window.localStorage.removeItem(stageKey);
        window.localStorage.removeItem(releaseKey);
      },
      {
        pairKey: MULTI_TAB_PAIR_STORAGE_KEY,
        stageKey: MULTI_TAB_TRANSITION_STAGE_KEY,
        releaseKey: MULTI_TAB_TRANSITION_RELEASE_KEY,
      },
    );
  }
});

test('an interrupted pair save keeps sibling context through triage and credential loss', async ({
  page,
  context,
}) => {
  await page.evaluate(
    ({ key, pair }) => window.localStorage.setItem(key, JSON.stringify(pair)),
    {
      key: MULTI_TAB_PAIR_STORAGE_KEY,
      pair: {
        server_url: 'wss://alice.recued.cloud:8443/ws',
        server_public_key: HARNESS_SERVER_PUBLIC_KEY,
        webclient_token: {
          token_id: 'tok-interruption-original',
          ciphertext_b64: 'ciphertext-original',
          iv_b64: 'iv-original',
          issued_at: 1_700_000_000,
        },
        pair_metadata: {
          paired_at: 1_700_000_000,
          server_passport_fingerprint: 'fp-original',
          server_handle_at_pair: 'alice',
          instance_id: 'browser-interruption-original',
        },
        cert_pin_state: null,
      },
    },
  );
  const siblingErrors: Error[] = [];
  const arrivalErrors: Error[] = [];
  const sibling = await context.newPage();
  const arrival = await context.newPage();
  sibling.on('pageerror', (error) => siblingErrors.push(error));
  arrival.on('pageerror', (error) => arrivalErrors.push(error));
  const base =
    'journey=multi-tab-transition&fail_pair_once=1&fail_sibling_startup_attempts=2&startup_failure_kind=server&chat=session';
  const sourceUrl =
    `${HARNESS_URL}?${base}&keep=source%20tab#connections`;
  const siblingUrl =
    `${HARNESS_URL}?${base}&keep=sibling%20tab#chat/session/chat_1`;
  const arrivalUrl =
    `${HARNESS_URL}?${base}&keep=arrival%20tab#chat/session/chat_1`;

  try {
    await Promise.all([page.goto(sourceUrl), sibling.goto(siblingUrl)]);
    await Promise.all([
      page.waitForFunction(() => window.__app?.ready === true),
      sibling.waitForFunction(() => window.__app?.ready === true),
    ]);
    await sibling.locator(`[${CHAT_INPUT}]`).fill(
      'Keep this draft through the interrupted browser save.',
    );
    await page.evaluate(() => window.__app.forceReauth());

    const sourceForm = page.getByRole('form', {
      name: 'Reconnect this browser',
    });
    const siblingForm = sibling.getByRole('form', {
      name: 'Reconnect this browser',
    });
    await expect(sourceForm).toBeVisible();
    await expect(siblingForm).toBeVisible();
    const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
    await sourceForm.locator(
      '#webclient-pair-code-input-recovery-0',
    ).fill(recoveryKey);
    await sourceForm.getByRole('button', {
      name: 'Reconnect this browser',
    }).click();

    const sourceInterrupted = sourceForm.locator(
      `[${PAIR_INTERRUPTED_NOTICE}][data-local-finalize-retry]`,
    );
    await expect(sourceInterrupted).toBeVisible();
    await expect(sourceInterrupted).toContainText('Server pairing is complete');
    await expect(sourceInterrupted).toContainText(
      'will not ask to pair again',
    );
    await expect(
      sourceForm.locator('#webclient-pair-code-input-status'),
    ).not.toContainText('Reload');
    const finish = sourceForm.getByRole('button', {
      name: 'Finish saving your sign-in',
    });
    await expect(finish).toBeFocused();
    await expect(sourceForm.getByRole('button', {
      name: 'Pair again with the recovery key',
    })).toHaveAttribute(
      'aria-describedby',
      'webclient-pair-code-input-restart-note',
    );
    expect(await page.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(1);

    const siblingInterrupted = siblingForm.locator(
      `[${PAIR_INTERRUPTED_NOTICE}]`,
    );
    await expect(siblingInterrupted).toBeVisible();
    await expect(siblingInterrupted).toContainText(
      'Another tab is reconnecting',
    );
    await expect(siblingInterrupted).toContainText(
      'old one-time code is cleared',
    );
    await expect(
      siblingForm.locator('#webclient-pair-code-input-recovery-0'),
    ).toBeFocused();

    await arrival.setViewportSize({ width: 280, height: 653 });
    await arrival.goto(arrivalUrl);
    await arrival.waitForFunction(() => window.__app?.ready === true);
    const arrivalRepair = arrival.locator(
      `[${COLD_START_CREDENTIAL_REPAIR}]`,
    );
    await expect(arrivalRepair).toBeVisible();
    await expect(arrivalRepair).toContainText('Browser setup was interrupted');
    await expect(
      arrival.locator(`[${COLD_START_CREDENTIAL_REPAIR_ACTION}]`),
    ).toBeFocused();

    await Promise.all([
      arrival.waitForEvent('domcontentloaded'),
      arrivalRepair.locator(
        `[${COLD_START_CREDENTIAL_RELOAD_ACTION}]`,
      ).click(),
    ]);
    await arrival.waitForFunction(() => window.__app?.ready === true);
    await expect(arrival).toHaveURL(arrivalUrl);
    await expect(arrivalRepair).toBeVisible();
    await expect(arrivalRepair).toContainText(
      'This tab reloaded, but this browser’s saved sign-in still needs fixing.',
    );
    await expect(arrivalRepair).toContainText(
      'another tab is still finishing that save',
    );
    await expect(
      arrival.locator(`[${COLD_START_CREDENTIAL_REPAIR_ACTION}]`),
    ).toBeFocused();
    expect(await arrival.evaluate(
      (key) => window.sessionStorage.getItem(key),
      STARTUP_RELOAD_RECOVERY_SESSION_KEY,
    )).toBeNull();
    await arrival.screenshot({
      path: test.info().outputPath(`full-app-credential-repair-reload-sibling-mobile.png`),
      fullPage: true,
    });

    await page.setViewportSize({ width: 280, height: 653 });
    const narrowRecovery = await sourceForm.evaluate((form) => {
      const rect = form.getBoundingClientRect();
      const buttons = Array.from(form.querySelectorAll('button')).map(
        (button) => button.getBoundingClientRect().height,
      );
      return {
        left: rect.left,
        right: rect.right,
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        minimumButtonHeight: Math.min(...buttons),
      };
    });
    expect(narrowRecovery.left).toBeGreaterThanOrEqual(-0.5);
    expect(narrowRecovery.right).toBeLessThanOrEqual(
      narrowRecovery.viewport + 0.5,
    );
    expect(narrowRecovery.documentWidth).toBeLessThanOrEqual(
      narrowRecovery.viewport,
    );
    expect(narrowRecovery.minimumButtonHeight).toBeGreaterThanOrEqual(36);
    await page.screenshot({
      path: test.info().outputPath(`full-app-interrupted-pair-save-mobile.png`),
      fullPage: true,
    });

    await finish.click();
    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      sibling.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);

    const arrivalStartupRecovery = arrival.locator(
      `[${POST_PAIR_STARTUP_RECOVERY}]`,
    );
    await expect(arrivalStartupRecovery).toBeVisible();
    await expect(arrivalStartupRecovery).toHaveAttribute('role', 'region');
    await expect(arrivalStartupRecovery).toContainText(
      'Sign-in saved in another tab',
    );
    await expect(arrivalStartupRecovery).toContainText(
      'Finish opening this tab',
    );
    await expect(arrivalStartupRecovery).toContainText(
      'This browser is already paired.',
    );
    await expect(arrivalStartupRecovery).toContainText(
      'Your page is still here.',
    );
    await expect(arrival).toHaveURL(arrivalUrl);
    await expect(arrivalRepair).toHaveCount(0);
    await expect(arrival.getByRole('form', {
      name: 'Reconnect this browser',
    })).toHaveCount(0);
    await expect(arrival.locator(`[${CONNECTION_BANNER}]`)).toHaveCount(0);
    expect(await arrival.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(0);
    expect(await arrival.evaluate(
      () => window.__app.credentialClearCount?.(),
    )).toBe(0);
    expect(await arrival.evaluate(() => window.__app.startupAttemptCount?.()))
      .toBe(1);

    const arrivalRetry = arrivalStartupRecovery.locator(
      `[${POST_PAIR_STARTUP_RECOVERY_ACTION}]`,
    );
    await expect(arrivalRetry).toHaveText('Try opening this tab again');
    await expect(arrivalRetry).toBeFocused();
    await expect(arrivalRetry).toHaveAttribute(
      'aria-describedby',
      'webclient-post-pair-startup-recovery-safe webclient-post-pair-startup-recovery-context',
    );
    const arrivalRecoveryLayout = await arrivalStartupRecovery.evaluate(
      (surface) => {
        const rect = surface.getBoundingClientRect();
        const button = surface.querySelector('button')?.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          buttonHeight: button?.height ?? 0,
        };
      },
    );
    expect(arrivalRecoveryLayout.left).toBeGreaterThanOrEqual(-0.5);
    expect(arrivalRecoveryLayout.right).toBeLessThanOrEqual(
      arrivalRecoveryLayout.viewportWidth + 0.5,
    );
    expect(arrivalRecoveryLayout.documentWidth).toBeLessThanOrEqual(
      arrivalRecoveryLayout.viewportWidth,
    );
    expect(arrivalRecoveryLayout.buttonHeight).toBeGreaterThanOrEqual(44);
    await arrival.screenshot({
      path: test.info().outputPath(`full-app-sibling-converged-startup-recovery-mobile.png`),
      fullPage: true,
    });

    await arrivalRetry.click();
    const arrivalTriage = arrival.locator(`[${STARTUP_FAILURE_TRIAGE}]`);
    await expect(arrivalTriage).toBeVisible();
    await expect(arrivalTriage).toHaveAttribute('role', 'region');
    await expect(arrivalTriage).toContainText('Sign-in saved in another tab');
    await expect(arrivalTriage).toContainText(
      'Another tab has already saved the sign-in',
    );
    await expect(arrivalTriage).toContainText(
      'Recued can’t reach your server',
    );
    await expect(arrivalTriage).toContainText('This browser is still paired.');
    await expect(arrivalTriage).toContainText(
      'Only this tab is trying again.',
    );
    await expect(arrivalTriage).toContainText(
      'You do not need to pair again',
    );
    await expect(
      arrivalTriage.locator(`[${STARTUP_FAILURE_TRIAGE_RELOAD}]`),
    ).toHaveCount(0);
    await expect(arrival.getByRole('form', {
      name: 'Reconnect this browser',
    })).toHaveCount(0);
    await expect(arrival.locator(`[${CONNECTION_BANNER}]`)).toHaveCount(0);
    await expect(arrival).toHaveURL(arrivalUrl);
    expect(await arrival.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(0);
    expect(await arrival.evaluate(
      () => window.__app.credentialClearCount?.(),
    )).toBe(0);
    expect(await arrival.evaluate(() => window.__app.startupAttemptCount?.()))
      .toBe(2);

    const triageRetry = arrivalTriage.locator(
      `[${STARTUP_FAILURE_TRIAGE_ACTION}]`,
    );
    await expect(triageRetry).toHaveText('Try reaching the server again');
    await expect(triageRetry).toBeFocused();
    await expect(triageRetry).toHaveAttribute(
      'aria-describedby',
      'webclient-startup-failure-triage-safety webclient-startup-failure-triage-context',
    );
    const triageLayout = await arrivalTriage.evaluate((surface) => {
      const rect = surface.getBoundingClientRect();
      const buttons = Array.from(surface.querySelectorAll('button')).map(
        (button) => button.getBoundingClientRect().height,
      );
      return {
        left: rect.left,
        right: rect.right,
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        minimumButtonHeight: Math.min(...buttons),
      };
    });
    expect(triageLayout.left).toBeGreaterThanOrEqual(-0.5);
    expect(triageLayout.right).toBeLessThanOrEqual(
      triageLayout.viewportWidth + 0.5,
    );
    expect(triageLayout.documentWidth).toBeLessThanOrEqual(
      triageLayout.viewportWidth,
    );
    expect(triageLayout.minimumButtonHeight).toBeGreaterThanOrEqual(44);
    await arrival.screenshot({
      path: test.info().outputPath(`full-app-sibling-converged-repeated-startup-mobile.png`),
      fullPage: true,
    });

    const diagnosticAction = arrivalTriage.locator(
      `[${STARTUP_FAILURE_DIAGNOSTIC_ACTION}]`,
    );
    await expect(diagnosticAction).toHaveText('Review safe diagnostic');
    await diagnosticAction.press('Enter');
    const diagnostic = arrivalTriage.locator(
      `[${STARTUP_FAILURE_DIAGNOSTIC}]`,
    );
    const diagnosticSummary = diagnostic.locator(
      `[${STARTUP_FAILURE_DIAGNOSTIC_SUMMARY}]`,
    );
    await expect(diagnostic).toBeVisible();
    await expect(diagnostic).toBeFocused();
    await expect(diagnosticSummary).toContainText(
      'Failure category: Server unreachable',
    );
    await expect(diagnosticSummary).toContainText(
      'Startup attempts in this tab: 2',
    );
    await expect(diagnosticSummary).toContainText(
      'Saved sign-in on this browser: Verified present',
    );
    await expect(diagnosticSummary).toContainText(
      'Server host: alice.recued.cloud:8443',
    );
    await expect(diagnosticSummary).not.toContainText('#chat/session');
    await expect(diagnosticSummary).not.toContainText('/ws');
    await expect(diagnosticSummary).not.toContainText('abandon');

    const reviewedDiagnostic = await diagnosticSummary.textContent();
    await diagnostic.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_COPY}]`).click();
    await expect(
      diagnostic.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_STATUS}]`),
    ).toContainText('Paste it wherever you are getting help');
    expect(await arrival.evaluate(
      () => window.__app.startupDiagnosticText?.(),
    )).toBe(reviewedDiagnostic);

    // The source now loses this browser's durable generation while the
    // arrival tab is still showing sibling-aware startup triage. The arrival
    // must retire that stale "pairing complete" claim without another click.
    await page.evaluate(() => window.__app.forceReauth());
    const arrivalForm = arrival.getByRole('form', {
      name: 'Reconnect this browser',
    });
    await expect(sourceForm).toBeVisible();
    await expect(siblingForm).toBeVisible();
    await expect(arrivalForm).toBeVisible();
    await expect(arrivalTriage).toHaveCount(0);
    await expect(arrival).toHaveURL(arrivalUrl);
    await expect(arrival.locator(`[${CONNECTION_BANNER}]`)).toHaveCount(0);
    expect(await arrival.evaluate(() => window.__app.startupAttemptCount?.()))
      .toBe(3);

    const arrivalNotice = arrivalForm.locator(`[${PAIR_REAUTH_NOTICE}]`);
    await expect(arrivalNotice).toHaveAttribute('role', 'status');
    await expect(arrivalNotice).toContainText(
      'Your sign-in changed while this tab was still working',
    );
    await expect(arrivalNotice).toContainText(
      'cleared or replaced the sign-in this tab was using',
    );
    await expect(arrivalNotice).toContainText(
      'stopped the old attempt before it could open your page',
    );
    await expect(arrivalNotice).toContainText(
      'Your page is still in this tab.',
    );
    await expect(arrivalForm).not.toContainText('This browser is still paired');
    await expect(
      arrivalForm.locator('#webclient-pair-code-input-server-url'),
    ).toHaveValue('https://alice.recued.cloud:8443');
    const arrivalRecoveryWord = arrivalForm.locator(
      '#webclient-pair-code-input-recovery-0',
    );
    await expect(arrivalRecoveryWord).toBeFocused();
    const arrivalPairLayout = await arrivalForm.evaluate((form) => {
      const rect = form.getBoundingClientRect();
      const primary = form.querySelector<HTMLButtonElement>(
        '#webclient-pair-code-input-submit',
      )?.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        primaryHeight: primary?.height ?? 0,
      };
    });
    expect(arrivalPairLayout.left).toBeGreaterThanOrEqual(-0.5);
    expect(arrivalPairLayout.right).toBeLessThanOrEqual(
      arrivalPairLayout.viewportWidth + 0.5,
    );
    expect(arrivalPairLayout.documentWidth).toBeLessThanOrEqual(
      arrivalPairLayout.viewportWidth,
    );
    expect(arrivalPairLayout.primaryHeight).toBeGreaterThanOrEqual(44);
    await arrival.screenshot({
      path: test.info().outputPath(`full-app-sibling-triage-credential-loss-mobile.png`),
      fullPage: true,
    });
    expect(await arrival.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(0);

    await arrivalRecoveryWord.fill(recoveryKey);
    await arrivalForm.getByRole('button', {
      name: 'Reconnect this browser',
    }).click();
    const arrivalFinish = arrivalForm.getByRole('button', {
      name: 'Finish saving your sign-in',
    });
    await expect(arrivalFinish).toBeVisible();
    await expect(arrivalFinish).toBeFocused();
    await expect(arrivalForm).toContainText('Server pairing is complete');
    await expect(arrivalForm).toContainText(
      'will not ask to pair again',
    );
    expect(await arrival.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(1);
    await arrivalFinish.click();
    await Promise.all([
      page.waitForFunction(
        () => window.__app.activeRoute() === 'connections',
      ),
      sibling.waitForFunction(() => window.__app.activeRoute() === 'chat'),
      arrival.waitForFunction(() => window.__app.activeRoute() === 'chat'),
    ]);

    await expect(page).toHaveURL(sourceUrl);
    await expect(sibling).toHaveURL(siblingUrl);
    await expect(arrival).toHaveURL(arrivalUrl);
    await expect(sourceForm).toHaveCount(0);
    await expect(siblingForm).toHaveCount(0);
    await expect(arrivalRepair).toHaveCount(0);
    await expect(arrivalForm).toHaveCount(0);
    await expect(sibling.locator(`[${CHAT_INPUT}]`)).toHaveValue(
      'Keep this draft through the interrupted browser save.',
    );
    await expect(sibling.locator(`[${CHAT_INPUT}]`)).toBeFocused();
    await expect(arrival.locator(`[${CHAT_SESSION_ROW}="chat_1"]`))
      .toHaveAttribute('aria-current', 'page');
    expect(await arrival.evaluate((contentAttr) => {
      const content = document.querySelector(`[${contentAttr}]`);
      return content instanceof HTMLElement
        && content.contains(document.activeElement);
    }, SHELL_CONTENT)).toBe(true);
    expect(await page.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(1);
    expect(await sibling.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(0);
    expect(await arrival.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(1);
    expect(await arrival.evaluate(
      () => window.__app.credentialClearCount?.(),
    )).toBe(0);
    expect(await arrival.evaluate(() => window.__app.startupAttemptCount?.()))
      .toBe(4);
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Reconnected');
    await expect(sibling.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Reconnected');
    await expect(arrival.locator(`[${CONNECTION_BANNER}]`))
      .toContainText('Reconnected. You’re back where you left off.');
    await expect(arrival.locator(`[${CONNECTION_BANNER}]`))
      .toHaveAttribute('data-state', 'restored');
    await expect(arrival.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText(STARTUP_RECOVERY_RETURN_RECEIPT_COPY);
    await expect(arrival.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText(STARTUP_RECOVERY_DRAFT_RETURN_RECEIPT_COPY);
    await expect(arrival.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('This browser is paired');
    expect(siblingErrors).toHaveLength(0);
    expect(arrivalErrors).toHaveLength(0);
  } finally {
    await Promise.all([sibling.close(), arrival.close()]);
    await page.evaluate(
      (key) => window.localStorage.removeItem(key),
      MULTI_TAB_PAIR_STORAGE_KEY,
    );
  }
});

for (const newDraft of ['Keep the unfinished new chat.', '']) {
  test(`guided re-pair keeps parked Chat work with a ${newDraft ? 'populated' : 'blank'} current composer`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${HARNESS_URL}?chat=session&journey=reauth#chat/session/chat_1`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const draft = 'Keep the existing conversation draft.';
    await page.locator(`[${CHAT_INPUT}]`).fill(draft);
    await openChatHistory(page);
    await page.locator('[data-recued-chat-route-new-session]').click();
    await expect(page).toHaveURL(/#chat\/new$/);
    await page.locator(`[${CHAT_INPUT}]`).fill(newDraft);

    await page.evaluate(() => window.__app.forceReauth());
    const form = page.getByRole('form', { name: 'Reconnect this browser' });
    await expect(form).toBeVisible();
    expect(await page.evaluate(() => window.dispatchEvent(
      new Event('beforeunload', { cancelable: true }),
    ))).toBe(false);
    await form.locator('#webclient-pair-code-input-recovery-0')
      .fill(`${Array(23).fill('abandon').join(' ')} art`);
    await form.getByRole('button', { name: 'Reconnect this browser', exact: true }).click();

    await expect(form).toHaveCount(0);
    await expect(page).toHaveURL(/#chat\/new$/);
    await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue(newDraft);
    await openChatHistory(page);
    await page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`).click();
    await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue(draft);
    await openChatHistory(page);
    await page.locator('[data-recued-chat-route-new-session]').click();
    await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue(newDraft);
    expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
    expect(await page.evaluate(() => window.__app.rpcCallCount('chat.session.create'))).toBe(0);
  });
}

test('reauth guides a secure re-pair and returns to the exact unsent Chat work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session&journey=reauth#chat/session/chat_1`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const draft = 'Draft the customer follow-up before sending.';
  const input = page.locator(`[${CHAT_INPUT}]`);
  await expect(input).toBeVisible();
  await input.fill(draft);
  await expect(input).toHaveValue(draft);

  await page.evaluate(() => window.__app.forceReauth());

  const pairForm = page.locator('#webclient-pair-code-input-form');
  await expect(pairForm).toBeVisible();
  await expect(
    page.getByRole('form', { name: 'Reconnect this browser' }),
  ).toBeVisible();
  await expect(
    pairForm.getByRole('heading', { name: 'Reconnect this browser' }),
  ).toBeVisible();
  const notice = pairForm.locator(`[${PAIR_REAUTH_NOTICE}]`);
  await expect(notice).toHaveAttribute('role', 'status');
  await expect(notice).toContainText('Your saved sign-in needs a look');
  await expect(notice).toContainText(
    'Your page and the Chat message you had not sent are still in this tab.',
  );
  await expect(notice).toContainText('go back to where you were');
  await expect(
    pairForm.locator('#webclient-pair-code-input-server-url'),
  ).toHaveValue('https://alice.recued.cloud:8443');
  await expect(pairForm).toContainText('recued pair');
  await expect(
    pairForm.getByRole('button', { name: 'Make a new one' }),
  ).toHaveCount(0);
  await expect(
    pairForm.getByRole('button', { name: 'Restore a backup' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      return window.dispatchEvent(event);
    }),
  ).toBe(false);

  const firstRecoveryWord = pairForm.locator(
    '#webclient-pair-code-input-recovery-0',
  );
  await expect(firstRecoveryWord).toBeFocused();
  const pairBounds = await pairForm.boundingBox();
  expect(pairBounds).not.toBeNull();
  expect(pairBounds!.x).toBeGreaterThanOrEqual(-0.5);
  expect(pairBounds!.x + pairBounds!.width).toBeLessThanOrEqual(390.5);
  await page.screenshot({
    path: test.info().outputPath(`full-app-reauth-guided-repair-mobile.png`),
    fullPage: true,
  });

  await page.setViewportSize({ width: 280, height: 653 });
  const narrowLayout = await page.evaluate(() => {
    const form = document.getElementById('webclient-pair-code-input-form');
    if (!(form instanceof HTMLElement)) {
      throw new Error('guided re-pair form is missing');
    }
    const rect = form.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(narrowLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowLayout.right).toBeLessThanOrEqual(
    narrowLayout.viewportWidth + 0.5,
  );
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
    narrowLayout.viewportWidth,
  );
  await page.setViewportSize({ width: 390, height: 844 });

  const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
  await firstRecoveryWord.fill(recoveryKey);
  const reconnect = pairForm.getByRole('button', {
    name: 'Reconnect this browser',
  });
  await expect(reconnect).toBeEnabled();
  await reconnect.click();

  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  const restoredInput = page.locator(`[${CHAT_INPUT}]`);
  await expect(restoredInput).toHaveValue(draft);
  await expect(restoredInput).toBeFocused();
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toContainText(
    'Reconnected. Your Chat draft is ready where you left it.',
  );
  expect(
    await page.evaluate(() => window.__app.rpcCallCount('chat.send')),
  ).toBe(0);
});

test('a rejected recovery key guides correction without losing the exact return work', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session&journey=reauth&reject_recovery_attempts=2#chat/session/chat_1`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const draft = 'Keep this draft while I correct the recovery key.';
  await page.locator(`[${CHAT_INPUT}]`).fill(draft);
  await page.evaluate(() => window.__app.forceReauth());

  const form = page.getByRole('form', { name: 'Reconnect this browser' });
  const server = form.locator('#webclient-pair-code-input-server-url');
  const pairingCode = form.locator('#webclient-pair-code-input-code');
  const firstRecoveryWord = form.locator(
    '#webclient-pair-code-input-recovery-0',
  );
  const lastRecoveryWord = form.locator(
    '#webclient-pair-code-input-recovery-23',
  );
  const reconnect = form.getByRole('button', {
    name: 'Reconnect this browser',
  });
  const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;

  await firstRecoveryWord.fill(recoveryKey);
  await expect(firstRecoveryWord).toBeFocused();
  await reconnect.click();

  const error = form.locator('[data-error="recovery_key_invalid"]');
  await expect(error).toContainText("do not match what your server has");
  const correction = form.locator(`[${PAIR_RECOVERY_CORRECTION}]`);
  await expect(correction).toBeVisible();
  await expect(form.locator(`[${PAIR_RECOVERY_TRIAGE}]`)).toHaveCount(0);
  await expect(correction).toBeFocused();
  await expect(correction).toHaveAttribute('role', 'group');
  await expect(correction).toContainText('Check the server and recovery key');
  await expect(correction).toContainText(
    'The 24 words passed Recued’s format check.',
  );
  await expect(correction).toContainText(
    'https://alice.recued.cloud:8443',
  );
  await expect(correction).toContainText(
    'A fresh pairing code cannot make a different recovery key match.',
  );
  await expect(firstRecoveryWord).toHaveValue('abandon');
  await expect(lastRecoveryWord).toHaveValue('art');
  await expect(reconnect).toBeDisabled();
  await expect(form).toContainText(
    'Check the server address, or type the recovery key again, before trying once more.',
  );
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(1);
  await page.screenshot({
    path: test.info().outputPath(`full-app-recovery-key-correction-mobile.png`),
    fullPage: true,
  });

  // A pairing-code edit is not a recovery-key correction and must not make
  // the mismatch disappear.
  await pairingCode.fill('FRESH-CODE');
  await expect(error).toBeVisible();
  await expect(correction).toBeVisible();
  await expect(reconnect).toBeDisabled();

  await page.setViewportSize({ width: 280, height: 653 });
  const narrowLayout = await correction.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const buttons = [...element.querySelectorAll('button')].map((button) => {
      const buttonRect = button.getBoundingClientRect();
      return { width: buttonRect.width, height: buttonRect.height };
    });
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      buttons,
    };
  });
  expect(narrowLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowLayout.right).toBeLessThanOrEqual(
    narrowLayout.viewportWidth + 0.5,
  );
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
    narrowLayout.viewportWidth,
  );
  expect(narrowLayout.buttons).toHaveLength(3);
  for (const button of narrowLayout.buttons) {
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.width).toBeGreaterThanOrEqual(44);
  }

  const recoveryHelp = form.locator(`[${PAIR_RECOVERY_HELP}]`);
  await correction.getByRole('button', { name: 'I can’t find the key' }).click();
  await expect(recoveryHelp).toHaveAttribute('open', '');
  await expect(
    recoveryHelp.getByText('Need help finding these details?', { exact: true }),
  ).toBeFocused();
  await expect(recoveryHelp).toContainText(
    'a fresh pairing code cannot replace the key',
  );
  await expect(firstRecoveryWord).toHaveValue('abandon');

  await correction.getByRole('button', { name: 'Review server address' }).click();
  await expect(correction).toBeVisible();
  await expect(error).toBeVisible();
  await expect(server).toBeFocused();
  await expect(server).toHaveValue('https://alice.recued.cloud:8443');
  await expect(firstRecoveryWord).toHaveValue('abandon');
  await expect(lastRecoveryWord).toHaveValue('art');
  await expect(reconnect).toBeDisabled();

  await server.fill('https://alice.recued.cloud:8443');
  await expect(correction).toHaveCount(0);
  await expect(error).toHaveCount(0);
  await expect(server).toBeFocused();
  await expect(reconnect).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await reconnect.click();
  await expect(correction).toBeVisible();
  await expect(correction).toBeFocused();
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(2);

  const triage = form.locator(`[${PAIR_RECOVERY_TRIAGE}]`);
  await expect(triage).toBeVisible();
  await expect(triage).toBeFocused();
  await expect(triage).toHaveAttribute('role', 'region');
  await expect(triage).toContainText('Wrong server or wrong saved key?');
  await expect(triage).toContainText(
    'Recued has now received 2 rejections for format-valid 24-word entries in this tab.',
  );
  await expect(triage).toContainText(
    'This address matches the scheme, hostname, and port this browser used before recovery',
  );
  await expect(triage.getByRole('heading', {
    name: 'Check the server',
  })).toBeVisible();
  await expect(triage.getByRole('heading', {
    name: 'Check the saved key',
  })).toBeVisible();
  await expect(triage).toContainText(
    'ask them to confirm only that address — never send them your recovery key',
  );

  const diagnostic = triage.locator(`[${PAIR_RECOVERY_DIAGNOSTIC}]`);
  const diagnosticSummary = diagnostic.locator(
    `[${PAIR_RECOVERY_DIAGNOSTIC_SUMMARY}]`,
  );
  await expect(diagnostic.getByText(
    'Details to show the server owner',
    { exact: true },
  )).toBeVisible();
  await diagnostic.getByText(
    'Details to show the server owner',
    { exact: true },
  ).click();
  await expect(diagnostic).toHaveAttribute('open', '');
  await expect(diagnosticSummary).toContainText(
    'Last server address tried: https://alice.recued.cloud:8443',
  );
  await expect(diagnosticSummary).toContainText(
    'Do the addresses match: matches the server this browser paired with before',
  );
  await expect(diagnosticSummary).not.toContainText('abandon');
  await expect(diagnosticSummary).not.toContainText('FRESH-CODE');
  await expect(diagnosticSummary).not.toContainText(draft);

  await page.setViewportSize({ width: 280, height: 653 });
  const narrowTriageLayout = await triage.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const summaryRect = element.querySelector('summary')?.getBoundingClientRect();
    const visibleButtons = [...element.querySelectorAll('button')]
      .map((button) => button.getBoundingClientRect())
      .filter((buttonRect) => buttonRect.height > 0)
      .map((buttonRect) => ({
        width: buttonRect.width,
        height: buttonRect.height,
      }));
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      summaryHeight: summaryRect?.height ?? 0,
      visibleButtons,
    };
  });
  expect(narrowTriageLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowTriageLayout.right).toBeLessThanOrEqual(
    narrowTriageLayout.viewportWidth + 0.5,
  );
  expect(narrowTriageLayout.documentWidth).toBeLessThanOrEqual(
    narrowTriageLayout.viewportWidth,
  );
  expect(narrowTriageLayout.summaryHeight).toBeGreaterThanOrEqual(44);
  expect(narrowTriageLayout.visibleButtons).toHaveLength(4);
  for (const button of narrowTriageLayout.visibleButtons) {
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.width).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: test.info().outputPath(`full-app-recovery-key-triage-narrow.png`),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });

  await correction.getByRole('button', {
    name: 'I confirmed the server — I can’t find the key',
  }).click();
  const pausedForm = page.getByRole('form', {
    name: 'Paused, and nothing was lost',
  });
  const recoveryStop = pausedForm.locator(`[${PAIR_RECOVERY_STOP}]`);
  const pausedServer = pausedForm.locator(
    '#webclient-pair-code-input-server-url',
  );
  const pausedPairingCode = pausedForm.locator(
    '#webclient-pair-code-input-code',
  );
  const pausedFirstRecoveryWord = pausedForm.locator(
    '#webclient-pair-code-input-recovery-0',
  );
  const pausedLastRecoveryWord = pausedForm.locator(
    '#webclient-pair-code-input-recovery-23',
  );
  await expect(recoveryStop).toBeVisible();
  await expect(recoveryStop).toBeFocused();
  await expect(recoveryStop).toHaveAttribute('role', 'region');
  await expect(recoveryStop.getByRole('heading', {
    name: 'Ask the person who manages this server',
  })).toBeVisible();
  await expect(recoveryStop).toContainText(
    'No pairing request is running, and this tab will not send another one unless you explicitly resume.',
  );
  await expect(recoveryStop).toContainText(
    'Confirmed server origin https://alice.recued.cloud:8443',
  );
  await expect(recoveryStop).toContainText(
    'This shareable origin omits any path or sign-in details.',
  );
  await expect(recoveryStop).toContainText(
    'The rejected recovery words and pairing code were cleared from this form.',
  );
  await expect(recoveryStop).toContainText(
    'Your page and the Chat message you had not sent are still here.',
  );
  await expect(recoveryStop).toContainText(
    'The person who has it should enter it only in this browser, never include it in the handoff.',
  );
  await expect(recoveryStop).toContainText(
    'Do not generate a replacement key, guess words, or keep retrying.',
  );
  await expect(recoveryStop).toContainText(
    'Recued cannot reveal or bypass the original key.',
  );
  await expect(pausedServer).toBeHidden();
  await expect(pausedServer).toHaveValue('');
  await expect(pausedPairingCode).toBeHidden();
  await expect(pausedPairingCode).toHaveValue('');
  await expect(pausedFirstRecoveryWord).toBeHidden();
  await expect(pausedFirstRecoveryWord).toHaveValue('');
  await expect(pausedLastRecoveryWord).toHaveValue('');
  await expect(pausedForm.getByRole('button', {
    name: 'Reconnect this browser',
  })).toHaveCount(0);

  const pausedDiagnostic = recoveryStop.locator(
    `[${PAIR_RECOVERY_DIAGNOSTIC}]`,
  );
  const pausedDiagnosticSummary = pausedDiagnostic.locator(
    `[${PAIR_RECOVERY_DIAGNOSTIC_SUMMARY}]`,
  );
  await expect(pausedDiagnostic).toHaveAttribute('open', '');
  await expect(pausedDiagnostic.getByText(
    'Details for the server owner, with nothing private in them',
    { exact: true },
  )).toBeVisible();
  await expect(pausedDiagnosticSummary).toContainText(
    'What to ask the server owner: is this the right address, and was the server replaced or reset? Do not ask them for the recovery key.',
  );
  await expect(pausedDiagnosticSummary).not.toContainText('abandon');
  await expect(pausedDiagnosticSummary).not.toContainText('FRESH-CODE');
  await expect(pausedDiagnosticSummary).not.toContainText(draft);
  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(2);
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send')))
    .toBe(0);

  await page.setViewportSize({ width: 280, height: 653 });
  const narrowStopLayout = await recoveryStop.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const summaryRect = element.querySelector('summary')?.getBoundingClientRect();
    const visibleButtons = [...element.querySelectorAll('button')]
      .map((button) => button.getBoundingClientRect())
      .filter((buttonRect) => buttonRect.height > 0)
      .map((buttonRect) => ({
        width: buttonRect.width,
        height: buttonRect.height,
      }));
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      summaryHeight: summaryRect?.height ?? 0,
      visibleButtons,
    };
  });
  expect(narrowStopLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowStopLayout.right).toBeLessThanOrEqual(
    narrowStopLayout.viewportWidth + 0.5,
  );
  expect(narrowStopLayout.documentWidth).toBeLessThanOrEqual(
    narrowStopLayout.viewportWidth,
  );
  expect(narrowStopLayout.summaryHeight).toBeGreaterThanOrEqual(44);
  expect(narrowStopLayout.visibleButtons).toHaveLength(3);
  for (const button of narrowStopLayout.visibleButtons) {
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.width).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: test.info().outputPath(`full-app-recovery-key-safe-stop-narrow.png`),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await recoveryStop.getByRole('button', {
    name: 'I found the original key',
  }).click();
  await expect(recoveryStop).toHaveCount(0);
  await expect(form).toBeVisible();
  await expect(firstRecoveryWord).toBeFocused();
  await expect(firstRecoveryWord).toHaveValue('');
  await expect(lastRecoveryWord).toHaveValue('');
  await expect(reconnect).toBeDisabled();

  await firstRecoveryWord.fill(recoveryKey);
  await expect(firstRecoveryWord).toBeFocused();
  await reconnect.click();
  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  const restoredInput = page.locator(`[${CHAT_INPUT}]`);
  await expect(restoredInput).toHaveValue(draft);
  await expect(restoredInput).toBeFocused();
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toContainText(
    'Reconnected. Your Chat draft is ready where you left it.',
  );
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(3);
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send')))
    .toBe(0);
});

test('an admin-confirmed server replacement reloads safely and completes one verified fresh pairing', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    ({ pairKey, pair }) => {
      window.localStorage.setItem(pairKey, JSON.stringify(pair));
    },
    {
      pairKey: MULTI_TAB_PAIR_STORAGE_KEY,
      pair: {
        server_url: 'wss://alice.recued.cloud:8443/ws',
        server_public_key: HARNESS_SERVER_PUBLIC_KEY,
        webclient_token: {
          token_id: 'tok-safe-stop-original',
          ciphertext_b64: 'ciphertext-safe-stop-original',
          iv_b64: 'iv-safe-stop-original',
          issued_at: 1_700_000_000,
        },
        pair_metadata: {
          paired_at: 1_700_000_000,
          server_passport_fingerprint: 'fp-safe-stop-original',
          server_handle_at_pair: 'alice',
          instance_id: 'browser-safe-stop-original',
        },
        cert_pin_state: null,
      },
    },
  );
  const exactUrl =
    `${HARNESS_URL}?chat=session&journey=multi-tab-transition&reject_recovery_attempts=2&replacement_server=1&keep=safe%20stop#chat/session/chat_1`;
  await page.goto(exactUrl);
  await page.waitForFunction(() => window.__app?.ready === true);

  const draft = 'Do not persist this draft across the safe-stop reload.';
  await page.locator(`[${CHAT_INPUT}]`).fill(draft);
  await page.evaluate(() => window.__app.forceReauth());

  let form = page.getByRole('form', { name: 'Reconnect this browser' });
  const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
  await form.locator('#webclient-pair-code-input-recovery-0')
    .fill(recoveryKey);
  const reconnect = form.getByRole('button', {
    name: 'Reconnect this browser',
  });
  await reconnect.click();
  await form.getByRole('button', { name: 'Review server address' }).click();
  await form.locator('#webclient-pair-code-input-server-url')
    .fill('https://alice.recued.cloud:8443');
  await reconnect.click();
  await form.getByRole('button', {
    name: 'I confirmed the server — I can’t find the key',
  }).click();

  await expect(page.getByRole('form', {
    name: 'Paused, and nothing was lost',
  })).toBeVisible();
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_REENTRY_SESSION_KEY,
  )).toBe('2');

  // A stale external handoff may append pairing inputs before this tab returns.
  // The replacement document must scrub those inputs and reconstruct only the
  // credential-free pause state from sessionStorage.
  await page.evaluate(() => {
    const [beforeHash, hash = ''] = window.location.href.split('#', 2);
    window.history.replaceState(
      window.history.state,
      '',
      `${beforeHash}&code=STALE-IN-ADDRESS&recued_pair_resume=same-origin${hash.length > 0 ? `#${hash}` : ''}`,
    );
  });
  page.once('dialog', async (dialog) => {
    await dialog.accept();
  });
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);

  await expect(page).toHaveURL(exactUrl);
  form = page.getByRole('form', { name: 'Still paused' });
  await expect(form).toBeVisible();
  const stop = form.locator(`[${PAIR_RECOVERY_STOP}]`);
  await expect(stop).toHaveAttribute(PAIR_RECOVERY_STOP_REENTRY, '');
  await expect(stop).toBeFocused();
  await expect(stop.getByRole('heading', {
    name: 'What did the server owner confirm?',
  })).toBeVisible();
  await expect(stop).toContainText('No recovery material was restored');
  await expect(stop).toContainText(
    'This return kept only the safe-stop state and the exact page selected in the address bar',
  );
  await expect(stop).toContainText(
    'It did not carry over a server address, pairing code, recovery key, rejection count, or diagnostic.',
  );
  await expect(stop).toContainText(
    'Leaving this page or reloading ended any in-memory Chat draft. Recued did not store that draft',
  );
  await expect(stop).toContainText(
    'Choose only the outcome they confirmed; otherwise leave this tab paused.',
  );
  await expect(form.locator(`[${PAIR_RECOVERY_DIAGNOSTIC}]`)).toHaveCount(0);
  await expect(form.locator(`[${PAIR_RECOVERY_CORRECTION}]`)).toHaveCount(0);
  await expect(form.locator(`[${PAIR_REAUTH_NOTICE}]`)).toHaveCount(0);
  await expect(form).not.toContainText('Keys that looked right but were refused');
  await expect(form).not.toContainText('https://alice.recued.cloud:8443');
  await expect(form).not.toContainText('STALE-IN-ADDRESS');
  await expect(form).not.toContainText(draft);
  await expect(form.locator('#webclient-pair-code-input-server-url'))
    .toHaveValue('');
  await expect(form.locator('#webclient-pair-code-input-code')).toHaveValue('');
  await expect(form.locator('#webclient-pair-code-input-recovery-0'))
    .toHaveValue('');
  await expect(form.getByRole('button', {
    name: 'Reconnect this browser',
  })).toHaveCount(0);
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.() ?? 0))
    .toBe(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.send')))
    .toBe(0);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_REENTRY_SESSION_KEY,
  )).toBe('2');
  const persistedBrowserState = await page.evaluate(() => JSON.stringify({
    session: Object.fromEntries(
      Array.from({ length: window.sessionStorage.length }, (_, index) => {
        const key = window.sessionStorage.key(index) ?? '';
        return [key, window.sessionStorage.getItem(key)];
      }),
    ),
    local: Object.fromEntries(
      Array.from({ length: window.localStorage.length }, (_, index) => {
        const key = window.localStorage.key(index) ?? '';
        return [key, window.localStorage.getItem(key)];
      }),
    ),
  }));
  expect(persistedBrowserState).not.toContain(draft);
  expect(persistedBrowserState).not.toContain(recoveryKey);
  expect(persistedBrowserState).not.toContain('STALE-IN-ADDRESS');

  await page.setViewportSize({ width: 280, height: 653 });
  const narrowLayout = await stop.evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    const buttons = [...surface.querySelectorAll('button')].map((button) => {
      const buttonRect = button.getBoundingClientRect();
      return { width: buttonRect.width, height: buttonRect.height };
    });
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      buttons,
    };
  });
  expect(narrowLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowLayout.right).toBeLessThanOrEqual(
    narrowLayout.viewportWidth + 0.5,
  );
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
    narrowLayout.viewportWidth,
  );
  expect(narrowLayout.buttons).toHaveLength(2);
  for (const button of narrowLayout.buttons) {
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.width).toBeGreaterThanOrEqual(44);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await stop.getByRole('button', {
    name: 'The server changed or was reset',
  }).click();
  form = page.getByRole('form', { name: 'Look at this server' });
  await expect(form).toBeVisible();
  await expect(stop).toHaveCount(0);
  const resumeNotice = form.locator(`[${PAIR_RECOVERY_RESUME_NOTICE}]`);
  await expect(resumeNotice).toContainText(
    'Use a fresh code from the current server',
  );
  await expect(resumeNotice).toContainText(
    'The previous address, one-time code, and recovery key were cleared.',
  );
  await expect(resumeNotice).toContainText(
    'The recovery-key step stays hidden until you review the server.',
  );
  await expect(resumeNotice).toContainText(
    'Starting fresh will not restore data from the previous server.',
  );
  await expect(form.locator(`[${PAIR_REAUTH_NOTICE}]`)).toHaveCount(0);
  let server = form.locator('#webclient-pair-code-input-server-url');
  let pairingCode = form.locator('#webclient-pair-code-input-code');
  await expect(server).toHaveValue('');
  await expect(server).toBeFocused();
  await expect(pairingCode).toHaveValue('');
  await expect(form.locator('#webclient-pair-code-input-recovery-0'))
    .toHaveCount(0);
  await expect(form.locator('.form-row-recovery')).toBeHidden();
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_REENTRY_SESSION_KEY,
  )).toBe('3');
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.() ?? 0))
    .toBe(0);

  // Replacement details are intentionally memory-only. An interrupted tab
  // returns to the same route and fresh-server checkpoint, never to a stale
  // address/code or the success receipt.
  await server.fill('https://discarded.example/private');
  await pairingCode.fill('DISCARD-1234');
  page.once('dialog', async (dialog) => {
    await dialog.accept();
  });
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);

  await expect(page).toHaveURL(exactUrl);
  form = page.getByRole('form', { name: 'Look at this server' });
  await expect(form).toBeVisible();
  server = form.locator('#webclient-pair-code-input-server-url');
  pairingCode = form.locator('#webclient-pair-code-input-code');
  await expect(server).toHaveValue('');
  await expect(server).toBeFocused();
  await expect(pairingCode).toHaveValue('');
  await expect(form).not.toContainText('discarded.example');
  await expect(form).not.toContainText('DISCARD-1234');
  await expect(form.locator(`[${PAIR_RECOVERY_STOP}]`)).toHaveCount(0);
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toHaveCount(0);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_REENTRY_SESSION_KEY,
  )).toBe('3');
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.() ?? 0))
    .toBe(0);

  const currentServerInput =
    'https://operator:secret@replacement.recued.cloud:9443/private?ignore=1#discarded';
  const freshCode = 'REPLACE-9443';
  await server.fill(currentServerInput);
  // Editing the destination invalidates any earlier code. Enter the code only
  // after the exact server has been chosen.
  await pairingCode.fill(freshCode);
  const reviewCurrentServer = form.getByRole('button', {
    name: 'Check this server',
  });
  await expect(reviewCurrentServer).toBeEnabled();
  await reviewCurrentServer.click();

  const replacementReview = form.locator(`[${PAIR_REPLACEMENT_REVIEW}]`);
  await expect(replacementReview).toBeVisible();
  await expect(replacementReview).toBeFocused();
  await expect(replacementReview.getByRole('heading', {
    name: 'Confirm this is the current server',
  })).toBeVisible();
  await expect(replacementReview).toContainText(
    'https://replacement.recued.cloud:9443',
  );
  await expect(replacementReview).toContainText(
    'Pairing does not restore missing data.',
  );
  await expect(replacementReview).toContainText(
    'Recued verifies and saves the server’s signed identity, then returns to the exact page selected in this tab.',
  );
  await expect(replacementReview).not.toContainText('operator:secret');
  await expect(replacementReview).not.toContainText('/private');
  await expect(replacementReview).not.toContainText('ignore=1');
  await expect(replacementReview).not.toContainText(freshCode);
  await expect(replacementReview).not.toContainText(recoveryKey);
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.() ?? 0))
    .toBe(0);

  await page.setViewportSize({ width: 280, height: 653 });
  const narrowReviewLayout = await replacementReview.evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    const buttons = [...surface.querySelectorAll('button')].map((button) => {
      const buttonRect = button.getBoundingClientRect();
      return { width: buttonRect.width, height: buttonRect.height };
    });
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      buttons,
    };
  });
  expect(narrowReviewLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowReviewLayout.right).toBeLessThanOrEqual(
    narrowReviewLayout.viewportWidth + 0.5,
  );
  expect(narrowReviewLayout.documentWidth).toBeLessThanOrEqual(
    narrowReviewLayout.viewportWidth,
  );
  expect(narrowReviewLayout.buttons).toHaveLength(3);
  for (const button of narrowReviewLayout.buttons) {
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.width).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: test.info().outputPath(`full-app-replacement-server-review-narrow.png`),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await replacementReview.getByRole('button', {
    name: 'Start fresh on this server',
  }).click();

  form = page.getByRole('form', { name: 'Set up this server' });
  const replacementConfirmed =
    form.locator(`[${PAIR_REPLACEMENT_CONFIRMED}]`);
  await expect(replacementConfirmed).toContainText(
    'You have chosen a fresh start for this server',
  );
  await expect(replacementConfirmed).toContainText(
    'You cannot use the old server’s key here',
  );
  await expect(form.locator('#webclient-pair-code-input-server-url'))
    .toHaveValue('');
  await expect(form.locator('#webclient-pair-code-input-code'))
    .toHaveValue('');
  const generateKey = form.getByRole('button', {
    name: 'Generate a new recovery key',
  });
  await expect(generateKey).toBeFocused();
  await generateKey.click();

  const generatedWords = form.locator('.rx-recovery-word-readonly span');
  await expect(generatedWords).toHaveCount(24);
  const newRecoveryKey = (await generatedWords.allTextContents()).join(' ');
  expect(newRecoveryKey.split(' ')).toHaveLength(24);
  expect(newRecoveryKey).not.toBe(recoveryKey);
  await form.getByRole('button', {
    name: "I've written it down — continue",
  }).click();
  const newRecoveryInput =
    form.locator('#webclient-pair-code-input-recovery-0');
  await newRecoveryInput.fill(newRecoveryKey);
  const pairFreshServer = form.getByRole('button', {
    name: 'Pair with this new server',
  });
  await expect(pairFreshServer).toBeEnabled();
  await pairFreshServer.click();

  await expect(page).toHaveURL(exactUrl);
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  const receipt = page.locator(`[${CONNECTION_BANNER}]`);
  await expect(receipt).toHaveAttribute('role', 'status');
  await expect(receipt).toHaveAttribute('data-state', 'restored');
  await expect(receipt).toContainText('The new link is checked and saved,');
  await expect(receipt).toContainText(
    'Nothing was brought over from the old server.',
  );
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue('');
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.() ?? 0))
    .toBe(1);
  expect(await page.evaluate(() => window.__app.lastPairingCode?.()))
    .toBe(freshCode);
  expect(await page.evaluate(() => window.__app.lastRecoveryKey?.()))
    .toBe(newRecoveryKey);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_REENTRY_SESSION_KEY,
  )).toBeNull();
  const pairedRecord = await page.evaluate((key) => {
    const value = window.localStorage.getItem(key);
    return value === null ? null : JSON.parse(value) as unknown;
  }, MULTI_TAB_PAIR_STORAGE_KEY);
  expect(pairedRecord).toMatchObject({
    server_url: 'wss://replacement.recued.cloud:9443/ws',
    server_public_key: 'spki-replacement-verified',
    pair_metadata: {
      server_passport_fingerprint: 'spki-replacement-verified',
      server_handle_at_pair: 'harbor',
    },
  });
  await page.screenshot({
    path: test.info().outputPath(`full-app-replacement-server-verified-return-mobile.png`),
    fullPage: true,
  });

  // A normal reload uses the durable verified pair, preserves the exact route,
  // and does not replay either the ceremony or its one-shot receipt.
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(exactUrl);
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  await expect(page.getByRole('form', {
    name: 'Look at this server',
  })).toHaveCount(0);
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .toHaveAttribute('data-state', 'ok');
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .not.toContainText('The new link is checked and saved');
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.() ?? 0))
    .toBe(0);
  expect(pageErrors).toHaveLength(0);
});

test('durable reconnect access retries only app startup and returns to exact unsent work', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  const target =
    `${HARNESS_URL}?chat=session&journey=reauth&fail_startup_once=1&keep=startup%20retry#chat/session/chat_1`;
  await page.goto(target);
  await page.waitForFunction(() => window.__app?.ready === true);

  const draft = 'Keep this draft while saved access opens again.';
  await page.locator(`[${CHAT_INPUT}]`).fill(draft);
  await page.evaluate(() => window.__app.forceReauth());

  const pairForm = page.getByRole('form', {
    name: 'Reconnect this browser',
  });
  await expect(pairForm).toBeVisible();
  const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
  await pairForm.locator(
    '#webclient-pair-code-input-recovery-0',
  ).fill(recoveryKey);
  await page.setViewportSize({ width: 280, height: 653 });
  await pairForm.getByRole('button', {
    name: 'Reconnect this browser',
  }).click();

  const startupRecovery = page.locator(`[${POST_PAIR_STARTUP_RECOVERY}]`);
  await expect(startupRecovery).toBeVisible();
  await expect(startupRecovery).toHaveAttribute('role', 'region');
  await expect(startupRecovery).toContainText('Sign-in saved');
  await expect(startupRecovery).toContainText(
    'You do not need to pair this browser again.',
  );
  await expect(startupRecovery).toContainText(
    'page and the Chat message you had not sent are still here',
  );
  await expect(pairForm).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(1);
  await expect(page).toHaveURL(target);
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      return window.dispatchEvent(event);
    }),
  ).toBe(false);

  const retry = startupRecovery.locator(
    `[${POST_PAIR_STARTUP_RECOVERY_ACTION}]`,
  );
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute(
    'aria-describedby',
    'webclient-post-pair-startup-recovery-safe webclient-post-pair-startup-recovery-context',
  );
  const narrowLayout = await startupRecovery.evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    const button = surface.querySelector('button')?.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      buttonHeight: button?.height ?? 0,
    };
  });
  expect(narrowLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowLayout.right).toBeLessThanOrEqual(
    narrowLayout.viewportWidth + 0.5,
  );
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
    narrowLayout.viewportWidth,
  );
  expect(narrowLayout.buttonHeight).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: test.info().outputPath(`full-app-post-pair-startup-recovery-mobile.png`),
    fullPage: true,
  });

  await retry.click();
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  await expect(page).toHaveURL(target);
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue(draft);
  await expect(page.locator(`[${CHAT_INPUT}]`)).toBeFocused();
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(1);
  const receipt = page.locator(`[${CONNECTION_BANNER}]`);
  await expect(receipt).toHaveAttribute('data-state', 'restored');
  await expect(receipt).toHaveAttribute('role', 'status');
  await expect(receipt).toHaveAttribute('aria-live', 'polite');
  await expect(receipt).toHaveAttribute('aria-atomic', 'true');
  await expect(receipt).toContainText(
    STARTUP_RECOVERY_DRAFT_RETURN_RECEIPT_COPY,
  );
  await expect(receipt).not.toContainText('Reconnected');
  await expect(receipt).not.toContainText('This browser is paired');
  const receiptLayout = await receipt.evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(receiptLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(receiptLayout.right).toBeLessThanOrEqual(
    receiptLayout.viewportWidth + 0.5,
  );
  expect(receiptLayout.documentWidth).toBeLessThanOrEqual(
    receiptLayout.viewportWidth,
  );
  await page.screenshot({
    path: test.info().outputPath(`full-app-startup-recovery-confirmation-mobile.png`),
    fullPage: true,
  });

  // The confirmation belongs only to this successful retry. A history/BFCache
  // restoration and a new runtime both retain the exact route without
  // replaying it.
  await page.goto(`${HARNESS_URL}?history-probe=startup-recovery-away`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.goBack();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(target);
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  await expect(receipt).toHaveAttribute('data-state', 'ok');
  await expect(receipt).not.toContainText('Recued started up again');

  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(target);
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  await expect(receipt).toHaveAttribute('data-state', 'ok');
  await expect(receipt).not.toContainText('Recued started up again');
  expect(pageErrors).toHaveLength(0);
});

test('repeated reconnect startup failure becomes guided triage without risking the draft', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  const target =
    `${HARNESS_URL}?chat=session&journey=reauth&fail_startup_attempts=2&startup_failure_kind=server&keep=repeated%20startup#chat/session/chat_1`;
  await page.goto(target);
  await page.waitForFunction(() => window.__app?.ready === true);

  const draft = 'Hold this draft through repeated startup recovery.';
  await page.locator(`[${CHAT_INPUT}]`).fill(draft);
  await page.evaluate(() => window.__app.forceReauth());

  const pairForm = page.getByRole('form', {
    name: 'Reconnect this browser',
  });
  const recoveryKey = `${Array(23).fill('abandon').join(' ')} art`;
  await pairForm.locator(
    '#webclient-pair-code-input-recovery-0',
  ).fill(recoveryKey);
  await pairForm.getByRole('button', {
    name: 'Reconnect this browser',
  }).click();

  const savedAccessRecovery = page.locator(
    `[${POST_PAIR_STARTUP_RECOVERY}]`,
  );
  await expect(savedAccessRecovery).toBeVisible();
  await savedAccessRecovery.locator(
    `[${POST_PAIR_STARTUP_RECOVERY_ACTION}]`,
  ).click();

  const triage = page.locator(`[${STARTUP_FAILURE_TRIAGE}]`);
  await expect(triage).toBeVisible();
  await expect(triage).toContainText('Recued still needs your help to start');
  await expect(triage).toContainText('Recued can’t reach your server');
  await expect(triage).toContainText(
    'page and the Chat message you had not sent are still here',
  );
  await expect(triage.locator(`[${STARTUP_FAILURE_TRIAGE_RELOAD}]`))
    .toHaveCount(0);
  await expect(pairForm).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(1);
  await expect(page).toHaveURL(target);

  const diagnosticAction = triage.locator(
    `[${STARTUP_FAILURE_DIAGNOSTIC_ACTION}]`,
  );
  await expect(diagnosticAction).toHaveText('Review safe diagnostic');
  await expect(diagnosticAction).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => window.__app.startupDiagnosticText?.()))
    .toBeNull();

  await diagnosticAction.press('Enter');

  const diagnostic = triage.locator(`[${STARTUP_FAILURE_DIAGNOSTIC}]`);
  const diagnosticSummary = diagnostic.locator(
    `[${STARTUP_FAILURE_DIAGNOSTIC_SUMMARY}]`,
  );
  await expect(diagnostic).toBeVisible();
  await expect(diagnostic).toBeFocused();
  await expect(diagnostic).toHaveAttribute(
    'aria-describedby',
    'webclient-startup-failure-diagnostic-privacy',
  );
  await expect(diagnostic).toHaveCSS('outline-width', '3px');
  await expect(diagnostic).toContainText('Nothing is sent automatically');
  await expect(diagnostic).toContainText(
    'The server host and any port are visible below',
  );
  await expect(diagnosticSummary).toContainText(
    'Failure category: Server unreachable',
  );
  await expect(diagnosticSummary).toContainText(
    'Startup attempts in this tab: 2',
  );
  await expect(diagnosticSummary).toContainText(
    'Browser network signal: Online hint',
  );
  await expect(diagnosticSummary).toContainText(
    'Server host: alice.recued.cloud:8443',
  );
  await expect(diagnosticSummary).toContainText(
    'leaves out error details, sign-in details, pairing codes',
  );
  await expect(diagnosticSummary).not.toContainText(draft);
  await expect(diagnosticSummary).not.toContainText('abandon');
  await expect(diagnosticSummary).not.toContainText('#chat/session');
  await expect(diagnosticSummary).not.toContainText('/ws');

  const reviewedSummary = await diagnosticSummary.textContent();
  await diagnostic.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_COPY}]`).click();
  await expect(
    diagnostic.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_STATUS}]`),
  ).toContainText('Paste it wherever you are getting help');
  expect(await page.evaluate(() => window.__app.startupDiagnosticText?.()))
    .toBe(reviewedSummary);

  await triage.locator(`[${STARTUP_FAILURE_TRIAGE_ACTION}]`).click();
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');

  await expect(page).toHaveURL(target);
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue(draft);
  await expect(page.locator(`[${CHAT_INPUT}]`)).toBeFocused();
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(1);
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toHaveAttribute(
    'data-state',
    'restored',
  );
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toContainText(
    STARTUP_RECOVERY_DRAFT_RETURN_RECEIPT_COPY,
  );
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .not.toContainText('Reconnected');
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .not.toContainText('This browser is paired');
  expect(pageErrors).toHaveLength(0);
});

test('paired cold-start failures stay on cause-aware retry until the exact page opens', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  const target =
    `${HARNESS_URL}?chat=session&journey=startup-failure&startup_failure_kind=server&startup_failure_attempts=2&keep=cold%20startup#chat/session/chat_1`;
  await page.setViewportSize({ width: 280, height: 720 });
  await page.goto(target);
  await page.waitForFunction(() => window.__app?.ready === true);

  const triage = page.locator(`[${STARTUP_FAILURE_TRIAGE}]`);
  await expect(triage).toBeVisible();
  await expect(triage).toHaveAttribute('role', 'region');
  await expect(triage).toHaveAttribute('aria-busy', 'false');
  await expect(triage).toContainText('Recued needs your help to start');
  await expect(triage).toContainText('Recued can’t reach your server');
  await expect(triage).toContainText('Your saved sign-in is still here.');
  await expect(triage).toContainText('page you opened is still chosen');
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page).toHaveURL(target);
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(0);
  expect(await page.evaluate(() => window.__app.startupAttemptCount?.()))
    .toBe(1);
  await expect(
    triage.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_ACTION}]`),
  ).toHaveCount(0);

  const retry = triage.locator(`[${STARTUP_FAILURE_TRIAGE_ACTION}]`);
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute(
    'aria-describedby',
    'webclient-startup-failure-triage-safety webclient-startup-failure-triage-context',
  );
  const narrowLayout = await triage.evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    const buttons = [...surface.querySelectorAll('button')]
      .map((button) => button.getBoundingClientRect().height);
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      buttonHeights: buttons,
    };
  });
  expect(narrowLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowLayout.right).toBeLessThanOrEqual(
    narrowLayout.viewportWidth + 0.5,
  );
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(
    narrowLayout.viewportWidth,
  );
  expect(narrowLayout.buttonHeights).toHaveLength(2);
  expect(narrowLayout.buttonHeights.every((height) => height >= 44)).toBe(true);

  await retry.click();

  await expect(triage.locator(`[${STARTUP_FAILURE_TRIAGE_STATUS}]`))
    .toHaveAttribute('role', 'alert');
  await expect(triage.locator(`[${STARTUP_FAILURE_TRIAGE_STATUS}]`))
    .toContainText('still cannot reach your server');
  expect(await page.evaluate(() => window.__app.startupAttemptCount?.()))
    .toBe(2);

  const diagnosticAction = triage.locator(
    `[${STARTUP_FAILURE_DIAGNOSTIC_ACTION}]`,
  );
  await expect(triage).toContainText('Recued still needs your help to start');
  await expect(diagnosticAction).toBeVisible();
  expect(await page.evaluate(() => window.__app.startupDiagnosticText?.()))
    .toBeNull();
  await diagnosticAction.click();

  const diagnostic = triage.locator(`[${STARTUP_FAILURE_DIAGNOSTIC}]`);
  const diagnosticSummary = diagnostic.locator(
    `[${STARTUP_FAILURE_DIAGNOSTIC_SUMMARY}]`,
  );
  await expect(diagnostic).toBeVisible();
  await expect(diagnostic).toContainText('Review before sharing');
  await expect(diagnosticSummary).toContainText(
    'Startup attempts in this tab: 2',
  );
  await expect(diagnosticSummary).toContainText(
    'Server host: alice.recued.cloud:8443',
  );
  await expect(diagnosticSummary).not.toContainText('#chat/session');
  await expect(diagnosticSummary).not.toContainText('/ws');

  const diagnosticLayout = await triage.evaluate((surface) => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    buttonHeights: [...surface.querySelectorAll('button')]
      .map((button) => button.getBoundingClientRect().height),
  }));
  expect(diagnosticLayout.documentWidth).toBeLessThanOrEqual(
    diagnosticLayout.viewportWidth,
  );
  expect(diagnosticLayout.buttonHeights).toHaveLength(4);
  expect(
    diagnosticLayout.buttonHeights.every((height) => height >= 44),
  ).toBe(true);

  const reviewedSummary = await diagnosticSummary.textContent();
  await diagnostic.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_COPY}]`).click();
  await expect(
    diagnostic.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_STATUS}]`),
  ).toContainText('Paste it wherever you are getting help');
  expect(await page.evaluate(() => window.__app.startupDiagnosticText?.()))
    .toBe(reviewedSummary);
  await page.screenshot({
    path: test.info().outputPath(`full-app-cold-start-failure-triage-mobile.png`),
    fullPage: true,
  });

  await triage.locator(`[${STARTUP_FAILURE_TRIAGE_ACTION}]`).click();
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');

  await expect(page).toHaveURL(target);
  await expect(page.locator(`[${SHELL_CONTENT}]`)).toBeFocused();
  expect(await page.evaluate(() => window.__app.startupAttemptCount?.()))
    .toBe(3);
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(0);
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toHaveAttribute(
    'data-state',
    'restored',
  );
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toContainText(
    STARTUP_RECOVERY_RETURN_RECEIPT_COPY,
  );
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .not.toContainText('This browser is paired');
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .not.toContainText('Reconnected');
  expect(pageErrors).toHaveLength(0);
});

test('a startup reload that still fails preserves repeated triage and the exact route', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  const target =
    `${HARNESS_URL}?journey=startup-failure&startup_failure_kind=server&startup_failure_attempts=1&startup_reload_still_fails=1&keep=reload%20still%20failing#connections`;
  await page.setViewportSize({ width: 280, height: 720 });
  await page.goto(target);
  await page.waitForFunction(() => window.__app?.ready === true);

  const triage = page.locator(`[${STARTUP_FAILURE_TRIAGE}]`);
  await expect(triage).toContainText('Recued needs your help to start');
  await expect(
    triage.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_ACTION}]`),
  ).toHaveCount(0);

  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    triage.locator(`[${STARTUP_FAILURE_TRIAGE_RELOAD}]`).click(),
  ]);
  await page.waitForFunction(() => window.__app?.ready === true);

  await expect(page).toHaveURL(target);
  await expect(triage).toBeVisible();
  await expect(triage).toHaveAttribute('role', 'region');
  await expect(triage).toHaveAttribute('aria-busy', 'false');
  await expect(triage).toContainText('Recued still needs your help to start');
  await expect(triage).toContainText(
    'This tab reloaded, but Recued still did not finish opening.',
  );
  await expect(triage).toContainText(
    'page you opened is still chosen',
  );
  await expect(page.locator(`[${CONNECTIONS_ROUTE}]`)).toHaveCount(0);
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.startupAttemptCount?.()))
    .toBe(1);
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(0);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    STARTUP_RELOAD_RECOVERY_SESSION_KEY,
  )).toBeNull();

  const retry = triage.locator(`[${STARTUP_FAILURE_TRIAGE_ACTION}]`);
  const diagnosticAction = triage.locator(
    `[${STARTUP_FAILURE_DIAGNOSTIC_ACTION}]`,
  );
  await expect(retry).toBeFocused();
  await expect(diagnosticAction).toHaveText('Review safe diagnostic');
  const collapsedLayout = await triage.evaluate((surface) => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    buttonHeights: [...surface.querySelectorAll('button')]
      .map((button) => button.getBoundingClientRect().height),
  }));
  expect(collapsedLayout.documentWidth).toBeLessThanOrEqual(
    collapsedLayout.viewportWidth,
  );
  expect(collapsedLayout.buttonHeights).toHaveLength(3);
  expect(
    collapsedLayout.buttonHeights.every((height) => height >= 44),
  ).toBe(true);

  await diagnosticAction.click();

  const diagnostic = triage.locator(`[${STARTUP_FAILURE_DIAGNOSTIC}]`);
  const diagnosticSummary = diagnostic.locator(
    `[${STARTUP_FAILURE_DIAGNOSTIC_SUMMARY}]`,
  );
  await expect(diagnostic).toBeVisible();
  await expect(diagnostic).toBeFocused();
  await expect(diagnosticSummary).toContainText(
    'Failure category: Server unreachable',
  );
  await expect(diagnosticSummary).toContainText(
    'Startup attempts in this tab: At least 2',
  );
  await expect(diagnosticSummary).toContainText(
    'Server host: alice.recued.cloud:8443',
  );
  await expect(diagnosticSummary).not.toContainText('full-app harness');
  await expect(diagnosticSummary).not.toContainText('reload still failing');
  await expect(diagnosticSummary).not.toContainText('#connections');
  await expect(diagnosticSummary).not.toContainText('/ws');
  await page.screenshot({
    path: test.info().outputPath(`full-app-startup-reload-still-failing-mobile.png`),
    fullPage: true,
  });

  const reviewedSummary = await diagnosticSummary.textContent();
  await diagnostic.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_COPY}]`).click();
  await expect(
    diagnostic.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_STATUS}]`),
  ).toContainText('Paste it wherever you are getting help');
  expect(await page.evaluate(() => window.__app.startupDiagnosticText?.()))
    .toBe(reviewedSummary);
  await retry.click();

  await page.waitForFunction(
    () => window.__app.activeRoute() === 'connections',
  );
  await expect(page).toHaveURL(target);
  await expect(page.locator(`[${CONNECTIONS_ROUTE}]`)).toBeVisible();
  await expect(page.locator(`[${SHELL_CONTENT}]`)).toBeFocused();
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toContainText(
    STARTUP_RECOVERY_RETURN_RECEIPT_COPY,
  );
  expect(await page.evaluate(() => window.__app.startupAttemptCount?.()))
    .toBe(2);
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(0);
  expect(pageErrors).toHaveLength(0);
});

test('an intentional startup reload returns to the exact page with one recovery confirmation', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  const target =
    `${HARNESS_URL}?journey=startup-failure&startup_failure_kind=server&startup_failure_attempts=1&keep=reload%20continuity#connections`;
  await page.setViewportSize({ width: 280, height: 720 });
  await page.goto(target);
  await page.waitForFunction(() => window.__app?.ready === true);

  const triage = page.locator(`[${STARTUP_FAILURE_TRIAGE}]`);
  await expect(triage).toBeVisible();
  await expect(page).toHaveURL(target);
  await expect(page.locator(`[${CONNECTIONS_ROUTE}]`)).toHaveCount(0);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    STARTUP_RELOAD_RECOVERY_SESSION_KEY,
  )).toBeNull();

  const reload = triage.locator(`[${STARTUP_FAILURE_TRIAGE_RELOAD}]`);
  await expect(reload).toHaveText('Reload this tab');
  await expect(reload).toHaveAttribute(
    'aria-describedby',
    'webclient-startup-failure-triage-safety webclient-startup-failure-triage-context',
  );
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    reload.click(),
  ]);
  await page.waitForFunction(() => window.__app?.ready === true);

  await expect(page).toHaveURL(target);
  await page.waitForFunction(
    () => window.__app.activeRoute() === 'connections',
  );
  await expect(page.locator(`[${CONNECTIONS_ROUTE}]`)).toBeVisible();
  await expect(page.locator('#webclient-boot-splash')).toHaveCount(0);
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.locator(`[${SHELL_CONTENT}]`)).toBeFocused();
  expect(await page.evaluate(() => window.__app.startupAttemptCount?.()))
    .toBe(1);
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(0);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    STARTUP_RELOAD_RECOVERY_SESSION_KEY,
  )).toBeNull();

  const receipt = page.locator(`[${CONNECTION_BANNER}]`);
  await expect(receipt).toHaveAttribute('data-state', 'restored');
  await expect(receipt).toHaveAttribute('role', 'status');
  await expect(receipt).toHaveAttribute('aria-live', 'polite');
  await expect(receipt).toContainText(
    STARTUP_RECOVERY_RETURN_RECEIPT_COPY,
  );
  const receiptLayout = await receipt.evaluate((surface) => {
    const rect = surface.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(receiptLayout.left).toBeGreaterThanOrEqual(-0.5);
  expect(receiptLayout.right).toBeLessThanOrEqual(
    receiptLayout.viewportWidth + 0.5,
  );
  expect(receiptLayout.documentWidth).toBeLessThanOrEqual(
    receiptLayout.viewportWidth,
  );
  await page.screenshot({
    path: test.info().outputPath(`full-app-startup-reload-recovery-mobile.png`),
    fullPage: true,
  });

  await page.goto(`${HARNESS_URL}?history-probe=startup-reload-away`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.goBack();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(target);
  await page.waitForFunction(
    () => window.__app.activeRoute() === 'connections',
  );
  await expect(receipt).toHaveAttribute('data-state', 'ok');
  await expect(receipt).not.toContainText('Recued started up again');

  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(target);
  await page.waitForFunction(
    () => window.__app.activeRoute() === 'connections',
  );
  await expect(receipt).toHaveAttribute('data-state', 'ok');
  await expect(receipt).not.toContainText('Recued started up again');
  expect(pageErrors).toHaveLength(0);
});
