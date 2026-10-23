import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  ACCOUNT_MENU_TRIGGER, ATTENTION_CLOSE, ATTENTION_DIALOG,
  CHAT_ANSWER_WAITING, CHAT_HISTORY_LANDING, CHAT_INPUT, CHAT_SEND,
  CONNECTION_BANNER, FIXED_NOW, HARNESS_URL, SHELL_HOST, installFullAppHooks,
} from './helpers/full-app.js';

/** Account, connection diagnosis, and server-switch journeys against the full-app harness. */
const SERVER_SWITCH_CONTINUITY_SESSION_KEY =
  'recued.webclient.server-switch-continuity.v1';
const RECOVERY_INTENT_CONTINUATION_SESSION_KEY =
  'recued.webclient.recovery-intent-continuation.v1';
const RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY =
  'recued.webclient.recovery-intent-deferred-check.v4';
const RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY =
  'recued.webclient.recovery-intent-review-verification.v2';
const RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS = 30 * 60_000;

const ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME =
  'data-recued-attention-recovery-intent-server-outcome';
const ATTENTION_RECOVERY_INTENT_SERVER_STATE =
  'data-recued-attention-recovery-intent-server-state';
const ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF =
  'data-recued-attention-recovery-intent-expiry-handoff';
const CONNECTION_BANNER_ACTION = 'data-recued-connection-banner-action';
const CONNECTION_STATUS_ANNOUNCER = 'data-recued-connection-status-announcer';
const ACCOUNT_MENU_BADGE = 'data-recued-account-menu-badge';
const ACCOUNT_MENU_POPOVER = 'data-recued-account-menu-popover';
const ACCOUNT_MENU_CLOSE = 'data-recued-account-menu-close';
const ACCOUNT_MENU_SETTINGS = 'data-recued-account-menu-settings';
const ACCOUNT_MENU_RECOVERY = 'data-recued-account-menu-recovery';
const ACCOUNT_MENU_RECOVERY_STEPS = 'data-recued-account-menu-recovery-steps';
const ACCOUNT_MENU_SERVER_SLOT = 'data-recued-account-menu-server-slot';
const ACCOUNT_MENU_CONNECTION_DIAGNOSIS =
  'data-recued-account-menu-connection-diagnosis';
const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE =
  'data-recued-account-menu-connection-diagnosis-title';
const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS =
  'data-recued-account-menu-connection-diagnosis-status';
const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT =
  'data-recued-account-menu-connection-diagnosis-receipt';
const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS =
  'data-recued-account-menu-connection-diagnosis-controls';
const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE =
  'data-recued-account-menu-connection-diagnosis-reconcile';
const ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN =
  'data-recued-account-menu-connection-diagnosis-return';
const SERVER_CONTROL_POPOVER =
  'data-recued-webclient-server-control-popover';
const SERVER_CONTROL_TITLE =
  'data-recued-webclient-server-control-title';
const SERVER_PROFILE_ITEM = 'data-recued-server-switcher-item';
const SERVER_PROFILE_CURRENT = 'data-recued-server-switcher-current';
const SERVER_PROFILE_RECENCY = 'data-recued-server-switcher-recency';
const SERVER_PROFILE_SWITCH_CONFIRM =
  'data-recued-server-switcher-switch-confirm';
const SERVER_PROFILE_SWITCH_COMMIT =
  'data-recued-server-switcher-switch-commit';
const SERVER_PROFILE_SWITCH_CANCEL =
  'data-recued-server-switcher-switch-cancel';
const SERVER_SWITCH_CONVERGENCE =
  'data-recued-server-switch-convergence';
const SERVER_SWITCH_CONVERGENCE_DIALOG =
  'data-recued-server-switch-convergence-dialog';
const SERVER_SWITCH_CONVERGENCE_DRAFT =
  'data-recued-server-switch-convergence-draft';
const SERVER_SWITCH_CONVERGENCE_CHECK =
  'data-recued-server-switch-convergence-check';
const SERVER_SWITCH_CONVERGENCE_COMMIT =
  'data-recued-server-switch-convergence-commit';
const SERVER_SWITCH_CONVERGENCE_STATUS =
  'data-recued-server-switch-convergence-status';
const SERVER_PROFILE_RENAME = 'data-recued-server-switcher-rename';
const SERVER_PROFILE_RENAME_FORM = 'data-recued-server-switcher-rename-form';
const SERVER_PROFILE_RENAME_INPUT = 'data-recued-server-switcher-rename-input';
const SERVER_PROFILE_RENAME_SAVE = 'data-recued-server-switcher-rename-save';
const SERVER_PROFILE_REMOVE = 'data-recued-server-switcher-remove';
const SERVER_PROFILE_REMOVE_CONFIRM =
  'data-recued-server-switcher-remove-confirm';
const SERVER_PROFILE_REMOVE_LOCAL =
  'data-recued-server-switcher-remove-local';
const SERVER_PROFILE_MENU = 'data-recued-server-switcher-menu';
const SERVER_PROFILE_ANNOUNCER = 'data-recued-server-switcher-announcer';

installFullAppHooks();

test('the Account popover closes when keyboard focus leaves it', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?server_profiles=multiple`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const trigger = page.locator(`[${ACCOUNT_MENU_TRIGGER}]`);
  await trigger.click();

  const dialog = page.locator(`[${ACCOUNT_MENU_POPOVER}]`);
  await expect(dialog).toBeVisible();
  const theme = dialog.getByRole('button', {
    name: 'Theme: System. Click to change.',
  });
  expect((await theme.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await trigger.click();
  await expect(dialog).toBeHidden();
  await trigger.click();

  const addServer = dialog.getByRole('button', {
    name: 'Add another server…',
  });
  await addServer.focus();
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');

  await expect(dialog).toBeHidden();
  // On a phone the next control is the button that opens the chat list.
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeFocused();
});

test('Account contains a maximum-length server name in switch review', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 480 });
  await page.goto(`${HARNESS_URL}?server_profiles=multiple`);
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click();
  const dialog = page.locator(`[${ACCOUNT_MENU_POPOVER}]`);
  const office = dialog.locator(`[${SERVER_PROFILE_ITEM}]`).filter({
    hasText: 'Office server',
  });
  const officeId = await office.getAttribute('data-profile-id');
  expect(officeId).not.toBeNull();
  const profileId = officeId!;
  await dialog.locator(
    `[${SERVER_PROFILE_RENAME}][data-profile-id="${profileId}"]`,
  ).click();
  const longName = 'X'.repeat(80);
  await dialog.locator(`[${SERVER_PROFILE_RENAME_INPUT}]`).fill(longName);
  await dialog.locator(`[${SERVER_PROFILE_RENAME_SAVE}]`).click();

  const renamed = dialog.locator(
    `[${SERVER_PROFILE_ITEM}][data-profile-id="${profileId}"]`,
  );
  await expect(renamed).toContainText(longName);
  await renamed.click();
  const confirmation = dialog.locator(`[${SERVER_PROFILE_SWITCH_CONFIRM}]`);
  await expect(confirmation).toContainText(`Switch to ${longName}?`);

  const geometry = await dialog.evaluate((node) => {
    const selectors = [
      '[data-recued-server-switcher-menu]',
      '[data-recued-server-switcher-switch-confirm]',
      '[data-recued-server-switcher-switch-confirm] h3',
      '[data-recued-server-switcher-switch-confirm] p',
    ];
    const elements = [
      node,
      ...selectors.map((selector) => node.querySelector<HTMLElement>(selector)),
    ].filter((element): element is HTMLElement => element !== null);
    return elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
  });
  for (const bounds of geometry) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }
});

test('the connection banner preserves focus when recovery retires its action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?server_profiles=multiple`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    window.__app.setServerAvailable(false);
    window.__app.fireState('closed');
  });

  const action = page.locator(`[${CONNECTION_BANNER_ACTION}]`);
  await expect(action).toBeVisible();
  await action.focus();
  await expect(action).toBeFocused();

  await page.evaluate(() => {
    window.__app.setServerAvailable(true);
    window.__app.fireState('connected');
  });

  await expect(action).toBeHidden();
  await expect(page.locator(`[${ACCOUNT_MENU_TRIGGER}]`)).toBeFocused();
});

test('bounded verification lands on one exact Account diagnosis and returns explicitly', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?journey=bounded-verification&server_profiles=multiple#contracts`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_heartbeat',
    payload: {
      server_id: 'srv-bounded-verification',
      last_seen_at: Date.now(),
      lifecycle_state: 'running',
      uptime_s: 120,
      supervisor_mode: 'systemd',
    },
  }));

  const bell = page.getByRole('button', {
    name: '1 item needs your attention',
  });
  await bell.click();
  const attention = page.locator(`[${ATTENTION_DIALOG}]`);
  await expect(attention.locator(
    '[data-phase="verification_handoff"]',
  )).toBeVisible();
  await attention.getByRole('button', {
    name: /Review the .* connection before another verification of Contracts/,
  }).click();

  const account = page.locator(`[${ACCOUNT_MENU_POPOVER}]`);
  const diagnosis = page.locator(`[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS}]`);
  const diagnosisTitle = diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE}]`,
  );
  const diagnosisStatus = diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS}]`,
  );
  await expect(account).toBeVisible();
  await expect(diagnosis).toBeVisible();
  await expect(diagnosisTitle).toBeFocused();
  await expect(diagnosis).toContainText(
    'Opening Account does not retry verification or mark it resolved.',
  );
  await expect(diagnosisStatus).toContainText('is connected now');
  const reviewControls = diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS}]`,
  );
  const reportOutcome = diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN}]`,
  );
  await expect(reviewControls).toBeEnabled();
  await reviewControls.click();
  const serverControls = page.locator(`[${SERVER_CONTROL_POPOVER}]`);
  const serverControlsTitle = page.locator(`[${SERVER_CONTROL_TITLE}]`);
  await expect(serverControls).toBeVisible();
  await expect(serverControls).toHaveAccessibleName('Active server controls');
  await expect(serverControlsTitle).toBeFocused();
  await expect(diagnosis).toHaveAttribute('data-control-review', 'active');
  await expect(diagnosisStatus).toContainText('controls are open');
  const controlReceipt = diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT}]`,
  );
  await serverControls.getByRole('button', { name: 'Pause server' }).press('Enter');
  const confirmPause = serverControls.getByRole('button', {
    name: 'Confirm pause',
  });
  await expect(confirmPause).toBeFocused();
  await confirmPause.press('Enter');
  await expect(controlReceipt).toBeVisible();
  await expect(controlReceipt).toHaveAttribute('data-action', 'pause');
  await expect(controlReceipt).toHaveAttribute('data-phase', 'confirmed');
  await expect(controlReceipt).toContainText(
    'Pause completed. The server confirmed work is paused.',
  );
  await expect(controlReceipt).toContainText(
    'This answer from the server does not prove Contracts.',
  );
  const resumeServer = serverControls.getByRole('button', { name: 'Resume' });
  await expect(resumeServer).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath(`full-app-account-diagnosis-controls-mobile.png`),
    fullPage: false,
  });

  // A live heartbeat may rebuild the control contents. Focus remains on the
  // exact resulting action instead of falling to the page behind the surface.
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_heartbeat',
    payload: {
      server_id: 'srv-bounded-verification',
      last_seen_at: Date.now(),
      lifecycle_state: 'running',
      uptime_s: 121,
      supervisor_mode: 'systemd',
      paused: true,
    },
  }));
  await expect(resumeServer).toBeFocused();

  // Connection loss closes the now-stale controls, keeps Account + diagnosis
  // open, and lands on the exact outcome button rather than a hidden subtree.
  await page.evaluate(() => window.__app.fireState('reconnecting'));
  await expect(serverControls).toHaveCount(0);
  await expect(diagnosisStatus).toContainText(
    'is reconnecting or still being checked',
  );
  await expect(reportOutcome).toBeFocused();
  await expect(reviewControls).toBeDisabled();
  await expect(account).toBeVisible();
  await page.evaluate(() => window.__app.fireState('connected'));
  await expect(diagnosisStatus).toContainText('is connected now');
  await expect(reviewControls).toBeDisabled();
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_heartbeat',
    payload: {
      server_id: 'srv-bounded-verification',
      last_seen_at: Date.now(),
      lifecycle_state: 'running',
      uptime_s: 1,
      supervisor_mode: 'systemd',
      paused: true,
    },
  }));
  await expect(reviewControls).toBeEnabled();
  await reviewControls.click();
  await expect(serverControlsTitle).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(account).toBeVisible();
  await expect(serverControls).toHaveCount(0);
  await expect(reportOutcome).toBeFocused();
  await expect(diagnosis).toHaveAttribute('data-control-review', 'returned');
  await expect(diagnosisStatus).toContainText('Back from');

  // The receipt remains live after returning. A later authoritative status
  // can supersede the action without moving focus or claiming route success.
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_heartbeat',
    payload: {
      server_id: 'srv-bounded-verification',
      last_seen_at: Date.now(),
      lifecycle_state: 'running',
      uptime_s: 2,
      supervisor_mode: 'systemd',
      paused: false,
    },
  }));
  await expect(controlReceipt).toHaveAttribute('data-phase', 'superseded');
  await expect(controlReceipt).toContainText(
    'a newer status from the server says work is running',
  );
  await expect(controlReceipt).toContainText(
    'does not prove Contracts',
  );
  await expect(reportOutcome).toBeFocused();

  // Quiet dismissal and a real reload keep the two-interruption cap. The
  // Account cue itself is deliberately memory-only and does not replay.
  await page.locator(`[${ACCOUNT_MENU_CLOSE}]`).click();
  await expect(account).toBeHidden();
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
  )).not.toBeNull();
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator(`[${ACCOUNT_MENU_POPOVER}]`)).toBeHidden();

  const restoredBell = page.getByRole('button', {
    name: '1 item needs your attention',
  });
  await restoredBell.click();
  const restoredAttention = page.locator(`[${ATTENTION_DIALOG}]`);
  await expect(restoredAttention.locator(
    '[data-phase="verification_handoff"]',
  )).toBeVisible();
  const readsBeforeReturn = await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts'));
  await restoredAttention.getByRole('button', {
    name: /Review the .* connection before another verification of Contracts/,
  }).click();
  await expect(controlReceipt).toBeHidden();
  await page.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN}]`,
  ).click();

  await expect(page.locator(`[${ACCOUNT_MENU_POPOVER}]`)).toBeHidden();
  await expect(page.locator(`[${ATTENTION_DIALOG}]`)).toBeVisible();
  await expect(page.locator(
    '[data-phase="awaiting_review_outcome"][data-review-target="server"]',
  )).toBeVisible();
  await expect(page.locator(`[${ATTENTION_DIALOG}]`)).toContainText(
    'What happened after you looked at',
  );
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
  )).toBeNull();
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBe(readsBeforeReturn);
});

test('carries a safe server receipt into Attention without replaying it after reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?journey=bounded-verification&server_profiles=multiple#contracts`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_heartbeat',
    payload: {
      server_id: 'srv-receipt-attention-handoff',
      last_seen_at: Date.now(),
      lifecycle_state: 'running',
      uptime_s: 120,
      supervisor_mode: 'systemd',
    },
  }));

  const bell = page.getByRole('button', {
    name: '1 item needs your attention',
  });
  await bell.click();
  const attention = page.locator(`[${ATTENTION_DIALOG}]`);
  await attention.getByRole('button', {
    name: /Review the .* connection before another verification of Contracts/,
  }).click();

  const account = page.locator(`[${ACCOUNT_MENU_POPOVER}]`);
  const diagnosis = page.locator(`[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS}]`);
  await diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS}]`,
  ).click();
  const serverControls = page.locator(`[${SERVER_CONTROL_POPOVER}]`);
  await serverControls.getByRole('button', { name: 'Pause server' }).click();
  await serverControls.getByRole('button', { name: 'Confirm pause' }).click();
  await expect(diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT}]`,
  )).toHaveAttribute('data-phase', 'confirmed');
  await page.keyboard.press('Escape');
  await diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN}]`,
  ).click();

  await expect(account).toBeHidden();
  await expect(attention).toBeVisible();
  await expect(page.locator(`[${ATTENTION_CLOSE}]`)).toBeFocused();
  const outcome = attention.locator(
    `[${ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME}="confirmed"]`
      + '[data-server-control-action="pause"]'
      + '[data-server-control-state="paused"]',
  );
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText('Pause completed');
  await expect(outcome).toContainText(
    'Last known state: work is paused.',
  );
  await expect(outcome).toContainText(
    'This answer from the server does not prove Contracts.',
  );
  await expect(outcome).toContainText('Pause will not replay.');
  await expect(outcome).not.toContainText(
    'What happened after you looked at',
  );
  const verify = outcome.getByRole('button', {
    name: /Verify Contracts on .* then choose again; Pause will not replay/,
  });
  await expect(verify).toHaveText('Verify Contracts & choose again');
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(1);
  await page.screenshot({
    path: test.info().outputPath(`full-app-attention-server-outcome-mobile.png`),
    fullPage: false,
  });

  await outcome.getByRole('button', {
    name: 'Still blocked; keep the saved return to Contracts',
  }).click();
  await expect(attention).toBeHidden();
  await bell.click();
  await expect(outcome).toBeVisible();
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(1);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
  )).toBeNull();
  expect(await page.evaluate((key) => {
    const raw = window.sessionStorage.getItem(key);
    return raw === null
      ? []
      : Object.keys(JSON.parse(raw) as Record<string, unknown>).sort();
  }, RECOVERY_INTENT_CONTINUATION_SESSION_KEY)).toEqual([
    'intent',
    'landing_hash',
    'paused_at',
    'profile_id',
    'v',
  ]);

  // The harness restores its durable bounded-verification posture, but the
  // receipt projection belongs to this page lifetime and cannot follow it.
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  const restoredBell = page.getByRole('button', {
    name: '1 item needs your attention',
  });
  await restoredBell.click();
  const restoredAttention = page.locator(`[${ATTENTION_DIALOG}]`);
  await expect(restoredAttention.locator(
    `[${ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME}]`,
  )).toHaveCount(0);
  await expect(restoredAttention).not.toContainText('Pause completed');
  await expect(restoredAttention).not.toContainText('Pause will not replay');
  await expect(restoredAttention).toContainText(
    'Look at the connection before checking again',
  );
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(0);
});

test('reconciles an unresolved receipt with current server state without replaying it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?journey=bounded-verification&server_profiles=multiple&server_control_response=hold#contracts`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_heartbeat',
    payload: {
      server_id: 'srv-unresolved-re-review',
      last_seen_at: Date.now(),
      lifecycle_state: 'running',
      paused: false,
      uptime_s: 120,
      supervisor_mode: 'systemd',
    },
  }));

  const bell = page.getByRole('button', {
    name: '1 item needs your attention',
  });
  await bell.click();
  const attention = page.locator(`[${ATTENTION_DIALOG}]`);
  await attention.getByRole('button', {
    name: /Review the .* connection before another verification of Contracts/,
  }).click();

  const account = page.locator(`[${ACCOUNT_MENU_POPOVER}]`);
  const diagnosis = page.locator(`[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS}]`);
  const diagnosisReceipt = diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT}]`,
  );
  await diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS}]`,
  ).click();
  const serverControls = page.locator(`[${SERVER_CONTROL_POPOVER}]`);
  await serverControls.getByRole('button', { name: 'Pause server' }).click();
  await serverControls.getByRole('button', { name: 'Confirm pause' }).click();
  await expect(diagnosisReceipt).toHaveAttribute('data-action', 'pause');
  await expect(diagnosisReceipt).toHaveAttribute('data-phase', 'pending');
  await expect(diagnosisReceipt).toContainText('Pause asked for');
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(1);

  await page.keyboard.press('Escape');
  const reportOutcome = diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN}]`,
  );
  await expect(reportOutcome).toBeFocused();
  await reportOutcome.click();

  await expect(account).toBeHidden();
  await expect(attention).toBeVisible();
  const outcome = attention.locator(
    `[${ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME}="pending"]`
      + '[data-server-control-action="pause"]',
  );
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText('Pause was still pending');
  await expect(outcome).toContainText(
    /Review .+ again to compare its current live state with this receipt/,
  );
  const reviewAgain = outcome.getByRole('button', {
    name: /Review the exact active-server controls for .* again; Pause will not replay/,
  });
  await expect(reviewAgain).toHaveText('Review server again');
  await expect(outcome.getByRole('button', {
    name: /Verify Contracts instead on .* then choose again; Pause will not replay/,
  })).toHaveText('Verify Contracts instead');
  await expect(outcome.getByRole('button', {
    name: /Still blocked/,
  })).toHaveCount(0);
  await expect(outcome.getByRole('button', {
    name: /Stop recovery/,
  })).toBeVisible();

  await reviewAgain.click();
  await expect(account).toBeVisible();
  await expect(diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE}]`,
  )).toContainText(/^Review .+ again$/);
  await expect(diagnosis).not.toHaveAttribute('data-interruption-reason');
  await expect(diagnosis).toContainText(
    'The last server-control receipt did not settle the result.',
  );
  await expect(diagnosisReceipt).toHaveAttribute('data-phase', 'pending');
  await expect(serverControls).toBeVisible();
  await expect(serverControls).toContainText(
    'Pause is still waiting for your server to answer.',
  );
  await expect(serverControls.getByRole('button', {
    name: 'Pause server',
  })).toBeDisabled();
  await expect(serverControls.locator(`[${SERVER_CONTROL_TITLE}]`)).toBeFocused();
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(1);
  await page.screenshot({
    path: test.info().outputPath(`full-app-attention-unresolved-server-re-review-mobile.png`),
    fullPage: false,
  });
  const reconcile = diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE}]`,
  );
  await expect(reconcile).toHaveText('Waiting to hear how the server is doing…');
  await expect(reconcile).toBeDisabled();
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
  )).toBeNull();

  // Settling the old RPC is not enough: the closure stays locked until a
  // subsequent heartbeat establishes what this exact server reports now.
  expect(await page.evaluate(() =>
    window.__app.releaseServerControlResponses?.())).toBe(1);
  await expect(serverControls).not.toContainText(
    'still awaiting a server response',
  );
  await expect(reconcile).toBeDisabled();
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_heartbeat',
    payload: {
      server_id: 'srv-unresolved-re-review',
      last_seen_at: Date.now(),
      lifecycle_state: 'running',
      paused: true,
      uptime_s: 121,
      supervisor_mode: 'systemd',
    },
  }));
  await expect(reconcile).toHaveText('Use what the server says now');
  await expect(reconcile).toBeEnabled();
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
  )).toBeNull();
  await expect(diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS}]`,
  )).toContainText(
    'stable current state ready to reconcile with the last receipt',
  );
  await expect(diagnosisReceipt).toContainText(
    /^Last receipt — Pause asked for/,
  );

  await page.keyboard.press('Escape');
  await expect(reconcile).toBeFocused();
  await reconcile.click();
  await expect(account).toBeHidden();
  await expect(attention).toBeVisible();
  const reconciled = attention.locator(
    `[${ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME}="pending"]`
      + `[${ATTENTION_RECOVERY_INTENT_SERVER_STATE}="paused"]`
      + '[data-server-control-action="pause"]',
  );
  await expect(reconciled).toBeVisible();
  await expect(reconciled).toContainText('Your server right now: paused');
  await expect(reconciled).toContainText(
    'It does not claim the earlier Pause caused it',
  );
  await expect(reconciled.getByRole('button', {
    name: /Review the exact active-server controls/,
  })).toHaveCount(0);
  const verify = reconciled.getByRole('button', {
    name: /Verify Contracts on .* then choose again; Pause will not replay/,
  });
  await expect(verify).toHaveText('Verify Contracts & choose again');
  await expect(reconciled.getByRole('button', {
    name: 'Still blocked; keep the saved return to Contracts',
  })).toBeVisible();
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(1);
  expect(await page.evaluate((key) => {
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw) as unknown;
  }, RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY)).toEqual({
    v: 2,
    profile_id: expect.any(String),
    landing_hash: '#contracts',
    intent: 'choose_again',
    paused_at: 1_700_000_000_000,
    review_target: 'server',
    state: 'ready',
    interruption_count: 0,
    last_interruption: null,
  });

  // Interrupt the reconciliation-to-area-check handoff. Reload restores only
  // the exact-area obligation: no historical receipt/current-state material,
  // no server-control replay, and no automatic read on reconnect.
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(0);
  const restoredBell = page.locator('[data-action="open-attention"]');
  await expect(restoredBell).toHaveAccessibleName(
    '1 item needs your attention',
  );
  await restoredBell.click();
  const restoredAttention = page.locator(`[${ATTENTION_DIALOG}]`);
  const readyCheck = restoredAttention.locator(
    '[data-phase="verification_ready"]',
  );
  await expect(readyCheck).toBeVisible();
  await expect(readyCheck).toContainText('Finish checking Contracts');
  await expect(readyCheck).toContainText(
    'The server finished looking, but the last Contracts check did not.',
  );
  await expect(readyCheck).toContainText(
    'only remembered where to go back to, and that you wanted to choose again',
  );
  await expect(readyCheck).toContainText(
    'not the server action, receipt, current state, or credentials',
  );
  await expect(readyCheck.locator(
    `[${ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME}]`,
  )).toHaveCount(0);
  await expect(readyCheck.locator(
    `[${ATTENTION_RECOVERY_INTENT_SERVER_STATE}]`,
  )).toHaveCount(0);
  await expect(readyCheck).not.toContainText('Pause was still pending');
  await expect(readyCheck).not.toContainText('Your server right now: paused');
  const resumedVerify = readyCheck.getByRole('button', {
    name: /Check Contracts now on .* no prior action or receipt will replay/,
  });
  await expect(resumedVerify).toHaveText('Check Contracts now');
  const keepForLater = readyCheck.getByRole('button', {
    name: /Keep the Contracts check for later on/,
  });
  await expect(keepForLater).toHaveText('Keep for later');
  const readsBeforeReconnect = await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts'));
  const routeBeforeDefer = page.url();
  const markersBeforeDefer = await page.evaluate(([parentKey, checkKey]) => ({
    parent: window.sessionStorage.getItem(parentKey),
    check: window.sessionStorage.getItem(checkKey),
  }), [
    RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
  ] as const);

  await keepForLater.click();
  await expect(restoredAttention).toBeHidden();
  await expect(restoredBell).toBeFocused();
  await expect(restoredBell).toHaveAccessibleName(
    'No items need your attention; 1 item saved for later',
  );
  await expect(restoredBell).toHaveClass(/top-bar-attention--saved/);
  await expect(restoredBell).not.toHaveClass(/top-bar-attention--ready/);
  await expect(restoredBell.locator(
    '.top-bar-attention-quiet-indicator',
  )).toHaveCount(0);
  await expect(restoredBell.locator('.top-bar-attention-badge')).toHaveCount(0);
  expect(page.url()).toBe(routeBeforeDefer);
  expect(await page.evaluate(([parentKey, checkKey]) => ({
    parent: window.sessionStorage.getItem(parentKey),
    check: window.sessionStorage.getItem(checkKey),
  }), [
    RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
  ] as const)).toEqual(markersBeforeDefer);
  expect(await page.evaluate((key) => {
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw) as unknown;
  }, RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY)).toEqual({
    v: 4,
    profile_id: expect.any(String),
    landing_hash: '#contracts',
    paused_at: FIXED_NOW,
    deferred_at: FIXED_NOW,
    review_started_at: null,
    attempt_count: 0,
    diagnosis_target: null,
    diagnosis_outcome: null,
  });
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBe(readsBeforeReconnect);
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(0);

  // Reopening Attention returns to the same explicit choice. Deferral neither
  // retires the exact-area obligation nor replays the historical receipt.
  await restoredBell.click();
  await expect(readyCheck).toBeVisible();
  await expect(readyCheck).toHaveAttribute('data-deferred', 'true');
  await expect(readyCheck).toContainText('Contracts check saved for later');
  await expect(readyCheck).toContainText(
    'Kept for later just now · expires in 30 min',
  );
  await expect(keepForLater).toBeVisible();
  await expect(readyCheck.locator(
    `[${ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME}]`,
  )).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath(`full-app-attention-reconciliation-reentry-mobile.png`),
    fullPage: false,
  });
  await page.evaluate(() => window.__app.fireState('reconnecting'));
  await page.evaluate(() => window.__app.fireState('connected'));
  await page.waitForTimeout(50);
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBe(readsBeforeReconnect);
  await expect(readyCheck).toHaveAttribute('data-phase', 'verification_ready');
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(0);

  await resumedVerify.click();
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBeGreaterThan(readsBeforeReconnect);
  await expect(restoredAttention).toBeHidden();
  await expect.poll(() => page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
  )).toBeNull();
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
  )).toBeNull();
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
  )).toBeNull();
  // The populated route has multiple panels backed by listContracts. Their
  // supporting reads may settle alongside the route-owned retry, but closure
  // must not leave a polling/retry loop behind.
  const readsAfterClosure = await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts'));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBe(readsAfterClosure);
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(0);
});

test('expires a deferred check into one quiet intent-free current-area review', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?journey=bounded-verification&server_profiles=multiple#chat`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.evaluate(([
    parentKey,
    checkKey,
    deferredKey,
    fixedNow,
    maxAge,
  ]) => {
    const current = window.sessionStorage.getItem(parentKey);
    if (current === null) throw new Error('missing bounded parent marker');
    const profileId = (JSON.parse(current) as { profile_id: string }).profile_id;
    const pausedAt = fixedNow - maxAge;
    window.sessionStorage.setItem(parentKey, JSON.stringify({
      v: 1,
      profile_id: profileId,
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: pausedAt,
    }));
    window.sessionStorage.setItem(checkKey, JSON.stringify({
      v: 2,
      profile_id: profileId,
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: pausedAt,
      review_target: 'server',
      state: 'ready',
      interruption_count: 0,
      last_interruption: null,
    }));
    window.sessionStorage.setItem(deferredKey, JSON.stringify({
      v: 4,
      profile_id: profileId,
      landing_hash: '#contracts',
      paused_at: pausedAt,
      deferred_at: pausedAt + 5 * 60_000,
      review_started_at: null,
      attempt_count: 0,
      diagnosis_target: null,
      diagnosis_outcome: null,
    }));
  }, [
    RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    FIXED_NOW,
    RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS,
  ] as const);
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);

  const bell = page.locator('[data-action="open-attention"]');
  await expect(bell).toHaveAccessibleName(
    'No items need your attention; 1 saved item ready to review',
  );
  await expect(bell).toHaveClass(/top-bar-attention--saved/);
  await expect(bell).toHaveClass(/top-bar-attention--ready/);
  await expect(bell.locator('.top-bar-attention-quiet-indicator')).toBeVisible();
  await expect(bell.locator('.top-bar-attention-badge')).toHaveCount(0);
  await expect(page).toHaveURL(/#chat$/);
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(0);
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
  )).toBeNull();
  expect(await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
  )).toBeNull();

  await bell.click();
  const attention = page.locator(`[${ATTENTION_DIALOG}]`);
  const expiry = attention.locator(
    `[${ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF}]`,
  );
  await expect(expiry).toBeVisible();
  await expect(expiry).toContainText('Saved Contracts check expired');
  await expect(expiry).toContainText(
    'discarded the prior intent and unfinished check',
  );
  await expect(expiry).toContainText('Expired just now · exact return removed');
  await expect(expiry).not.toContainText('choose_again');
  await expect(expiry.locator(
    `[${ATTENTION_RECOVERY_INTENT_SERVER_OUTCOME}]`,
  )).toHaveCount(0);
  await expect(expiry.locator(
    `[${ATTENTION_RECOVERY_INTENT_SERVER_STATE}]`,
  )).toHaveCount(0);
  const reviewCurrent = expiry.getByRole('button', {
    name: /Review current Contracts; no expired intent or prior action will replay/,
  });
  await expect(reviewCurrent).toHaveText('Review current Contracts');
  await page.screenshot({
    path: test.info().outputPath(`full-app-attention-deferred-expiry-mobile.png`),
    fullPage: false,
  });

  const readsBeforeReview = await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts'));
  expect(readsBeforeReview).toBe(0);
  await reviewCurrent.click();
  await expect(page).toHaveURL(/#contracts$/);
  await expect(attention).toBeHidden();
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBeGreaterThan(readsBeforeReview);
  await expect(page.locator('[data-recued-contracts-route-heading]'))
    .toBeFocused();
  await expect.poll(() => page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
  )).toBeNull();
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(0);

  // The bounded harness seeds only when its query is present. Removing that
  // test-only seed proves the consumed notice does not return on a cold boot.
  await page.evaluate(() => {
    window.history.replaceState(null, '', `${window.location.pathname}#contracts`);
  });
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  const coldBell = page.locator('[data-action="open-attention"]');
  await expect(coldBell).toHaveAccessibleName('No items need your attention');
  await coldBell.click();
  await expect(page.locator(
    `[${ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF}]`,
  )).toHaveCount(0);
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(0);
});

test('keeps one quiet route-owned retry when an expired current-area review is unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?journey=bounded-verification&server_profiles=multiple&contract_read_failures=1#chat`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.evaluate(([
    parentKey,
    checkKey,
    deferredKey,
    fixedNow,
    maxAge,
  ]) => {
    const current = window.sessionStorage.getItem(parentKey);
    if (current === null) throw new Error('missing bounded parent marker');
    const profileId = (JSON.parse(current) as { profile_id: string }).profile_id;
    const pausedAt = fixedNow - maxAge;
    window.sessionStorage.setItem(parentKey, JSON.stringify({
      v: 1,
      profile_id: profileId,
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: pausedAt,
    }));
    window.sessionStorage.setItem(checkKey, JSON.stringify({
      v: 2,
      profile_id: profileId,
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: pausedAt,
      review_target: 'server',
      state: 'ready',
      interruption_count: 0,
      last_interruption: null,
    }));
    window.sessionStorage.setItem(deferredKey, JSON.stringify({
      v: 4,
      profile_id: profileId,
      landing_hash: '#contracts',
      paused_at: pausedAt,
      deferred_at: pausedAt + 5 * 60_000,
      review_started_at: null,
      attempt_count: 0,
      diagnosis_target: null,
      diagnosis_outcome: null,
    }));
  }, [
    RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    FIXED_NOW,
    RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS,
  ] as const);
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);

  const bell = page.locator('[data-action="open-attention"]');
  await bell.click();
  const attention = page.locator(`[${ATTENTION_DIALOG}]`);
  const expiry = attention.locator(
    `[${ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF}]`,
  );
  const reviewCurrent = expiry.getByRole('button', {
    name: /Review current Contracts; no expired intent or prior action will replay/,
  });
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts'))).toBe(0);
  await reviewCurrent.click();

  await expect(page).toHaveURL(/#contracts$/);
  await expect(attention).toBeHidden();
  await expect(bell).toHaveAccessibleName(
    'No items need your attention; 1 saved review needs retry',
  );
  await expect(bell).toHaveClass(/top-bar-attention--retry/);
  await expect(bell.locator('.top-bar-attention-badge')).toHaveCount(0);
  await expect(page.locator('[data-recued-contracts-error]')).toBeFocused();

  const readsAfterFailure = await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts'));
  const storedRetry = await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
  );
  expect(storedRetry).not.toBeNull();
  expect(JSON.parse(storedRetry!)).toMatchObject({
    v: 4,
    landing_hash: '#contracts',
    review_started_at: FIXED_NOW,
    attempt_count: 1,
    diagnosis_target: null,
    diagnosis_outcome: null,
  });
  expect(storedRetry).not.toMatch(
    /choose_again|intent|credential|receipt|record|provider|private harness/i,
  );

  await bell.click();
  await expect(expiry).toHaveAttribute('data-phase', 'retry');
  await expect(expiry).toHaveAttribute('data-retry-reason', 'unavailable');
  await expect(expiry).toContainText('Contracts could not be brought up to date');
  await expect(expiry).toContainText('Try the current area again');
  await expect(expiry).not.toContainText('private harness current-area failure');
  const retry = expiry.getByRole('button', {
    name: /Retry current Contracts; no expired intent or prior action will replay/,
  });
  await page.screenshot({
    path: test.info().outputPath(`full-app-attention-expired-review-retry-mobile.png`),
    fullPage: false,
  });

  await page.evaluate(() => {
    window.__app.fireState('reconnecting');
    window.__app.fireState('connected');
  });
  await page.waitForTimeout(50);
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBe(readsAfterFailure);

  await retry.click();
  await expect(attention).toBeHidden();
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBeGreaterThan(readsAfterFailure);
  await expect.poll(() => page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
  )).toBeNull();
  await expect(page.locator('[data-recued-contracts-route-heading]'))
    .toBeFocused();
  await expect(bell).toHaveAccessibleName('No items need your attention');
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(0);
});

test('bounds a repeated expired-area retry to direct route diagnosis', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?journey=bounded-verification&server_profiles=multiple&contract_read_failures=100#chat`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.evaluate(([
    parentKey,
    checkKey,
    deferredKey,
    fixedNow,
    maxAge,
  ]) => {
    const current = window.sessionStorage.getItem(parentKey);
    if (current === null) throw new Error('missing bounded parent marker');
    const profileId = (JSON.parse(current) as { profile_id: string }).profile_id;
    const pausedAt = fixedNow - maxAge;
    window.sessionStorage.setItem(parentKey, JSON.stringify({
      v: 1,
      profile_id: profileId,
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: pausedAt,
    }));
    window.sessionStorage.setItem(checkKey, JSON.stringify({
      v: 2,
      profile_id: profileId,
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: pausedAt,
      review_target: 'server',
      state: 'ready',
      interruption_count: 0,
      last_interruption: null,
    }));
    window.sessionStorage.setItem(deferredKey, JSON.stringify({
      v: 4,
      profile_id: profileId,
      landing_hash: '#contracts',
      paused_at: pausedAt,
      deferred_at: pausedAt + 5 * 60_000,
      review_started_at: null,
      attempt_count: 0,
      diagnosis_target: null,
      diagnosis_outcome: null,
    }));
  }, [
    RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    FIXED_NOW,
    RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS,
  ] as const);
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);

  const bell = page.locator('[data-action="open-attention"]');
  const attention = page.locator(`[${ATTENTION_DIALOG}]`);
  const expiry = attention.locator(
    `[${ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF}]`,
  );
  await bell.click();
  await expiry.getByRole('button', {
    name: /Review current Contracts; no expired intent or prior action will replay/,
  }).click();
  await expect(bell).toHaveAccessibleName(
    'No items need your attention; 1 saved review needs retry',
  );

  await bell.click();
  await expiry.getByRole('button', {
    name: /Retry current Contracts; no expired intent or prior action will replay/,
  }).click();
  await expect(bell).toHaveAccessibleName(
    'No items need your attention; 1 saved review needs diagnosis',
  );
  await expect(bell).toHaveClass(/top-bar-attention--diagnosis/);
  await expect(bell.locator('.top-bar-attention-badge')).toHaveCount(0);
  const readsAtLimit = await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts'));

  await bell.click();
  await expect(expiry).toHaveAttribute('data-phase', 'handoff');
  await expect(expiry).toHaveAttribute('data-diagnosis-target', 'area');
  await expect(expiry).toContainText('Contracts needs direct review');
  await expect(expiry).toContainText(
    'Recued stopped after two unsuccessful checks',
  );
  await expect(expiry).not.toContainText('private harness current-area failure');
  const directReview = expiry.getByRole('button', {
    name: /Open current Contracts; no expired intent or prior action will replay/,
  });
  await page.screenshot({
    path: test.info().outputPath(`full-app-attention-expired-review-diagnosis-mobile.png`),
    fullPage: false,
  });

  await page.evaluate(() => {
    window.__app.fireState('reconnecting');
    window.__app.fireState('connected');
  });
  await page.waitForTimeout(50);
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBe(readsAtLimit);

  await directReview.click();
  await expect(attention).toBeHidden();
  await expect(page.locator('[data-recued-contracts-error]')).toBeFocused();
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBe(readsAtLimit);
  await expect(bell).toHaveAccessibleName('No items need your attention');
  await expect.poll(() => page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
  )).toBeNull();
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(0);
});

test('bounds a repeated offline expired-area retry to exact server diagnosis', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?journey=bounded-verification&server_profiles=multiple#chat`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.evaluate(([
    parentKey,
    checkKey,
    deferredKey,
    fixedNow,
    maxAge,
  ]) => {
    const current = window.sessionStorage.getItem(parentKey);
    if (current === null) throw new Error('missing bounded parent marker');
    const profileId = (JSON.parse(current) as { profile_id: string }).profile_id;
    const pausedAt = fixedNow - maxAge;
    window.sessionStorage.setItem(parentKey, JSON.stringify({
      v: 1,
      profile_id: profileId,
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: pausedAt,
    }));
    window.sessionStorage.setItem(checkKey, JSON.stringify({
      v: 2,
      profile_id: profileId,
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: pausedAt,
      review_target: 'server',
      state: 'ready',
      interruption_count: 0,
      last_interruption: null,
    }));
    window.sessionStorage.setItem(deferredKey, JSON.stringify({
      v: 4,
      profile_id: profileId,
      landing_hash: '#contracts',
      paused_at: pausedAt,
      deferred_at: pausedAt + 5 * 60_000,
      review_started_at: fixedNow,
      attempt_count: 1,
      diagnosis_target: null,
      diagnosis_outcome: null,
    }));
  }, [
    RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    FIXED_NOW,
    RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS,
  ] as const);
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    window.__app.setServerAvailable(false);
    window.__app.fireState('closed');
  });
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).toBeVisible();

  const bell = page.locator('[data-action="open-attention"]');
  const attention = page.locator(`[${ATTENTION_DIALOG}]`);
  const expiry = attention.locator(
    `[${ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF}]`,
  );
  const readsBeforeDiagnosis = await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts'));
  await bell.click();
  await expiry.getByRole('button', {
    name: /Retry current Contracts; no expired intent or prior action will replay/,
  }).click();
  await expect(bell).toHaveAccessibleName(
    'No items need your attention; 1 saved review needs diagnosis',
  );
  await expect(bell).toHaveClass(/top-bar-attention--diagnosis/);

  await bell.click();
  await expect(expiry).toHaveAttribute('data-phase', 'handoff');
  await expect(expiry).toHaveAttribute('data-diagnosis-target', 'server');
  await expect(expiry).toContainText('needs connection review');
  await expect(expiry).toContainText(
    'Recued stopped after two connection-blocked checks',
  );
  await expiry.getByRole('button', {
    name: /Review .*; no expired intent or prior action will replay/,
  }).click();

  const account = page.locator(`[${ACCOUNT_MENU_POPOVER}]`);
  const diagnosis = account.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS}]`,
  );
  const diagnosisTitle = diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE}]`,
  );
  await expect(account).toBeVisible();
  await expect(diagnosis).toBeVisible();
  await expect(diagnosisTitle).toBeFocused();
  await expect(diagnosisTitle).toContainText('for Contracts');
  await expect(diagnosis).toContainText(
    'stopped after two unsuccessful current Contracts checks',
  );
  await expect(diagnosis).toContainText(
    'This review will not retry Contracts',
  );
  await expect(diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS}]`,
  )).toContainText('cannot be reached');
  const finish = diagnosis.locator(
    `[${ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN}]`,
  );
  await expect(finish).toHaveText('Choose: check, or close');
  await page.screenshot({
    path: test.info().outputPath(`full-app-attention-expired-review-server-diagnosis-mobile.png`),
    fullPage: false,
  });
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBe(readsBeforeDiagnosis);

  await finish.click();
  await expect(account).toBeHidden();
  await expect(attention).toBeVisible();
  await expect(attention.locator(`[${ATTENTION_CLOSE}]`)).toBeFocused();
  await expect(bell).toHaveAccessibleName(
    'No items need your attention; 1 saved review needs a decision',
  );
  await expect(bell).toHaveClass(/top-bar-attention--decision/);
  await expect(expiry).toHaveAttribute('data-phase', 'outcome');
  await expect(expiry).toHaveAttribute('data-check-blocker', 'server');
  await expect(expiry).toContainText('before the fresh check');
  const waitingForServer = expiry.getByRole('button', {
    name: /Waiting for .* before one current Contracts check; reconnect will not start it/,
  });
  await expect(waitingForServer).toHaveText('Waiting for server');
  await expect(waitingForServer).toBeDisabled();
  const closeReview = expiry.getByRole('button', { name: 'Close review' });
  await expect(closeReview).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath(`full-app-attention-expired-review-outcome-mobile.png`),
    fullPage: false,
  });
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBe(readsBeforeDiagnosis);
  await closeReview.click();
  await expect(bell).toHaveAccessibleName('No items need your attention');
  await expect.poll(() => page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
  )).toBeNull();
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(0);
});

test('runs one deliberate post-diagnosis current-area check without reviving expired work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?journey=bounded-verification&server_profiles=multiple#chat`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.evaluate(([
    parentKey,
    checkKey,
    deferredKey,
    fixedNow,
    maxAge,
  ]) => {
    const current = window.sessionStorage.getItem(parentKey);
    if (current === null) throw new Error('missing bounded parent marker');
    const profileId = (JSON.parse(current) as { profile_id: string }).profile_id;
    const pausedAt = fixedNow - maxAge;
    window.sessionStorage.setItem(parentKey, JSON.stringify({
      v: 1,
      profile_id: profileId,
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: pausedAt,
    }));
    window.sessionStorage.setItem(checkKey, JSON.stringify({
      v: 2,
      profile_id: profileId,
      landing_hash: '#contracts',
      intent: 'choose_again',
      paused_at: pausedAt,
      review_target: 'server',
      state: 'ready',
      interruption_count: 0,
      last_interruption: null,
    }));
    window.sessionStorage.setItem(deferredKey, JSON.stringify({
      v: 4,
      profile_id: profileId,
      landing_hash: '#contracts',
      paused_at: pausedAt,
      deferred_at: pausedAt + 5 * 60_000,
      review_started_at: fixedNow,
      attempt_count: 2,
      diagnosis_target: 'server',
      diagnosis_outcome: 'choose',
    }));
  }, [
    RECOVERY_INTENT_CONTINUATION_SESSION_KEY,
    RECOVERY_INTENT_REVIEW_VERIFICATION_SESSION_KEY,
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
    FIXED_NOW,
    RECOVERY_INTENT_CONTINUATION_MAX_AGE_MS,
  ] as const);
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);

  const bell = page.locator('[data-action="open-attention"]');
  const attention = page.locator(`[${ATTENTION_DIALOG}]`);
  const expiry = attention.locator(
    `[${ATTENTION_RECOVERY_INTENT_EXPIRY_HANDOFF}]`,
  );
  await expect(bell).toHaveAccessibleName(
    'No items need your attention; 1 saved review needs a decision',
  );
  const readsBefore = await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts'));
  await bell.click();
  await expect(expiry).toHaveAttribute('data-phase', 'outcome');
  await expiry.getByRole('button', {
    name: /Check current Contracts once; the expired intent and prior action will remain removed/,
  }).click();

  await expect(attention).toBeHidden();
  await expect.poll(() => new URL(page.url()).hash).toBe('#contracts');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBeGreaterThan(readsBefore);
  await expect.poll(() => page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    RECOVERY_INTENT_DEFERRED_CHECK_SESSION_KEY,
  )).toBeNull();
  await expect(page.locator(
    '[data-recued-contracts-route-heading]',
  )).toBeFocused();
  await expect(bell).toHaveAccessibleName('No items need your attention');
  const readsAfter = await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts'));
  await page.evaluate(() => {
    window.__app.fireState('reconnecting');
    window.__app.fireState('connected');
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('collection.contract.listContracts')))
    .toBe(readsAfter);
  expect(await page.evaluate(() =>
    window.__app.rpcCallCount('server.setPaused'))).toBe(0);
});

test('Account server profiles own connection status, recovery, and the return online', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?server_profiles=multiple`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_heartbeat',
    payload: {
      server_id: 'sha256:account-e2e',
      last_seen_at: Date.now(),
      lifecycle_state: 'running',
      uptime_s: 43_200,
      supervisor_mode: 'systemd',
    },
  }));

  const account = page.locator(`[${ACCOUNT_MENU_TRIGGER}]`);
  const dialog = page.locator(`[${ACCOUNT_MENU_POPOVER}]`);
  const banner = page.locator(`[${CONNECTION_BANNER}]`);
  const announcer = page.locator(`[${CONNECTION_STATUS_ANNOUNCER}]`);
  await expect(account).toBeVisible();
  await expect(account).toHaveAccessibleName('Your account and servers');
  const accountTarget = await account.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(accountTarget.width).toBeGreaterThanOrEqual(44);
  expect(accountTarget.height).toBeGreaterThanOrEqual(44);

  await account.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toHaveAccessibleName('Account & servers');
  await expect(dialog).toBeFocused();
  await expect(dialog.getByRole('heading', {
    name: 'Account & servers',
    level: 2,
  })).toBeVisible();
  await expect(dialog.getByRole('heading', {
    name: 'Server profiles',
    level: 3,
  })).toBeVisible();
  const profiles = dialog.locator(`[${SERVER_PROFILE_ITEM}]`);
  await expect(profiles).toHaveCount(2);
  const currentProfile = dialog.locator(
    `[${SERVER_PROFILE_ITEM}][aria-current="true"]`,
  );
  await expect(currentProfile).toContainText('alice');
  await expect(
    currentProfile.locator(`[${SERVER_PROFILE_CURRENT}]`),
  ).toHaveText('Current');
  await expect(
    currentProfile.locator(`[${SERVER_PROFILE_RECENCY}]`),
  ).toHaveText('Connected now');
  const officeProfile = profiles.filter({ hasText: 'Office server' });
  const officeRow = officeProfile.locator('..');
  await officeRow.locator(`[${SERVER_PROFILE_RENAME}]`).click();
  const renameForm = dialog.locator(`[${SERVER_PROFILE_RENAME_FORM}]`);
  await expect(renameForm).toBeVisible();
  const renameInput = renameForm.locator(`[${SERVER_PROFILE_RENAME_INPUT}]`);
  await expect(renameInput).toBeFocused();
  await renameInput.fill('作業サーバー');
  const composingEscape = await renameInput.evaluate((input) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    const dispatched = input.dispatchEvent(event);
    return { dispatched, defaultPrevented: event.defaultPrevented };
  });
  expect(composingEscape).toEqual({
    dispatched: true,
    defaultPrevented: false,
  });
  await expect(dialog).toBeVisible();
  await expect(renameForm).toBeVisible();
  await expect(renameInput).toHaveValue('作業サーバー');
  await expect(renameInput).toBeFocused();

  await renameInput.fill('Work server');
  await renameForm.locator(`[${SERVER_PROFILE_RENAME_SAVE}]`).click();
  await expect(renameForm).toHaveCount(0);
  const renamedProfile = profiles.filter({ hasText: 'Work server' });
  await expect(renamedProfile).toBeVisible();
  await expect(
    renamedProfile.locator('..').locator(`[${SERVER_PROFILE_RENAME}]`),
  ).toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(`[${ACCOUNT_MENU_RECOVERY}]`)).toBeHidden();
  const serverStatus = dialog.locator(`[${ACCOUNT_MENU_SERVER_SLOT}]`);
  await expect(serverStatus.locator('.server-pill')).toBeVisible();

  // The current-server health/control surface used to be hidden by a mobile
  // breakpoint left over from its retired topbar placement.
  await page.setViewportSize({ width: 280, height: 653 });
  await expect(serverStatus.locator('.server-pill')).toBeVisible();
  const mobilePillTarget = await serverStatus.locator('.server-pill').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(mobilePillTarget.height).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: 390, height: 844 });

  // Escape first returns from the nested active-server controls to their
  // owning pill. A second Escape still closes Account, so the new diagnosis
  // handoff cannot swallow the ordinary Account keyboard path.
  const serverPillButton = serverStatus.locator('.server-pill[data-action]');
  await serverPillButton.click();
  const ordinaryServerControls = page.locator(`[${SERVER_CONTROL_POPOVER}]`);
  await expect(ordinaryServerControls).toBeVisible();
  await expect(page.locator(`[${SERVER_CONTROL_TITLE}]`)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(ordinaryServerControls).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(serverPillButton).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(account).toBeFocused();

  await page.evaluate(() => window.__app.fireState('reconnecting'));
  await expect(announcer).toContainText('reconnecting by itself');
  await expect(banner).toHaveAttribute('data-state', 'ok');

  await page.evaluate(() => {
    window.__app.setServerAvailable(false);
    window.__app.fireState('closed');
  });
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('role', 'alert');
  await expect(banner).toContainText(
    'Recued cannot reach this server. It will keep trying.',
  );
  await expect(
    banner.locator(`[${CONNECTION_BANNER_ACTION}]`),
  ).toHaveText('Look at your servers');
  await expect(account).toHaveAccessibleName(
    'Your account and servers. Recued cannot reach this server',
  );
  await expect(
    page.locator(`[${ACCOUNT_MENU_BADGE}]`),
  ).toHaveAttribute('data-state', 'unreachable');

  await banner.locator(`[${CONNECTION_BANNER_ACTION}]`).click();
  await expect(dialog).toBeVisible();
  const recovery = dialog.locator(`[${ACCOUNT_MENU_RECOVERY}]`);
  await expect(recovery).toBeVisible();
  await expect(
    recovery.getByRole('heading', { name: 'Can’t reach your server' }),
  ).toBeFocused();
  await expect(
    recovery.locator(`[${ACCOUNT_MENU_RECOVERY_STEPS}] li`),
  ).toHaveCount(2);
  await expect(recovery).toContainText('pick another saved server');
  await expect(currentProfile).toHaveAttribute('data-unreachable', 'true');
  await expect(currentProfile).toContainText('not reachable');
  await expect(dialog).toContainText('Work server');

  await page.setViewportSize({ width: 280, height: 653 });
  const narrowGeometry = await dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const styles = getComputedStyle(node);
    return {
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      overflowY: styles.overflowY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollY: window.scrollY,
    };
  });
  expect(narrowGeometry.scrollY).toBe(0);
  expect(narrowGeometry.top).toBeGreaterThanOrEqual(-0.5);
  expect(narrowGeometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(narrowGeometry.right).toBeLessThanOrEqual(
    narrowGeometry.viewportWidth + 0.5,
  );
  expect(narrowGeometry.bottom).toBeLessThanOrEqual(
    narrowGeometry.viewportHeight + 0.5,
  );
  expect(narrowGeometry.overflowY).toBe('auto');
  const touchTargets = await page.locator([
    `[${ACCOUNT_MENU_TRIGGER}]`,
    `[${ACCOUNT_MENU_CLOSE}]`,
    `[${CONNECTION_BANNER_ACTION}]`,
    `[${SERVER_PROFILE_ITEM}][aria-current="true"]`,
    `[${SERVER_PROFILE_RENAME}]`,
  ].join(',')).evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  for (const target of touchTargets) {
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: test.info().outputPath(`full-app-account-server-recovery-mobile.png`),
    fullPage: false,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.__app.setServerAvailable(true);
    window.__app.fireState('connected');
  });
  await expect(banner).toHaveAttribute('data-state', 'restored');
  await expect(banner).toHaveAttribute('role', 'status');
  await expect(banner).toContainText(
    'Back online. Your server is reachable again.',
  );
  await expect(account).toHaveAccessibleName('Your account and servers');
  await expect(recovery).toBeHidden();
  await expect(dialog).toBeFocused();
  await expect(currentProfile).not.toHaveAttribute('data-unreachable', 'true');
  await expect(dialog).toContainText('Work server');

  await dialog.locator(`[${ACCOUNT_MENU_SETTINGS}]`).click();
  await expect(page).toHaveURL(/#settings\/account$/);
  await page.waitForFunction(() => window.__app.activeRoute() === 'settings');
  await expect(dialog).toBeHidden();
});

test('Account keeps the surviving profile roster open after forgetting another server', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?server_profiles=multiple`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const account = page.locator(`[${ACCOUNT_MENU_TRIGGER}]`);
  await account.click();
  const dialog = page.locator(`[${ACCOUNT_MENU_POPOVER}]`);
  const profiles = dialog.locator(`[${SERVER_PROFILE_ITEM}]`);
  const office = profiles.filter({ hasText: 'Office server' });
  await office.locator('..').locator(`[${SERVER_PROFILE_REMOVE}]`).click();

  const removal = dialog.locator(`[${SERVER_PROFILE_REMOVE_CONFIRM}]`);
  await expect(removal).toHaveAccessibleName('Remove Office server?');
  await expect(removal.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await removal.locator(`[${SERVER_PROFILE_REMOVE_LOCAL}]`).click();

  await expect(dialog).toBeVisible();
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  await expect(removal).toHaveCount(0);
  await expect(profiles).toHaveCount(1);
  await expect(profiles).not.toContainText('Office server');
  await expect(dialog.locator(`[${SERVER_PROFILE_MENU}]`)).toBeFocused();
  await expect(dialog.locator(`[${SERVER_PROFILE_ANNOUNCER}]`))
    .toContainText('no longer saved on this browser');
  await expect(
    dialog.locator(`[${SERVER_PROFILE_ITEM}][aria-current="true"]`),
  ).toContainText('alice');
});

test('a deliberate server switch protects the draft boundary and returns to a clean target area once', async ({ page }) => {
  const pageErrors: Error[] = [];
  const nativeDialogs: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('dialog', async (dialog) => {
    nativeDialogs.push(dialog.type());
    await dialog.dismiss();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?server_profiles=multiple&chat=session#chat/session/chat_1`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const draft = page.locator(`[${CHAT_INPUT}]`);
  await expect(draft).toBeVisible();
  await draft.fill('Private thought for the home server');
  const account = page.locator(`[${ACCOUNT_MENU_TRIGGER}]`);
  await account.click();
  const accountDialog = page.locator(`[${ACCOUNT_MENU_POPOVER}]`);
  const office = accountDialog
    .locator(`[${SERVER_PROFILE_ITEM}]`)
    .filter({ hasText: 'Office server' });
  await office.click();

  const review = accountDialog.locator(`[${SERVER_PROFILE_SWITCH_CONFIRM}]`);
  await expect(review).toBeVisible();
  await expect(review).toHaveAccessibleName('Switch to Office server?');
  await expect(review).toContainText('The Chat message you have not sent is only in this tab');
  await expect(review).toContainText(
    'Chats, records, runs and links belong to one server and stay there',
  );
  await page.screenshot({
    path: test.info().outputPath(`full-app-deliberate-server-switch-mobile.png`),
    fullPage: false,
  });
  const switchTargets = await review.locator('button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
  for (const target of switchTargets) {
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
  }
  await review.locator(`[${SERVER_PROFILE_SWITCH_CANCEL}]`).click();
  await expect(review).toHaveCount(0);
  await expect(office).toBeFocused();
  await expect(draft).toHaveValue('Private thought for the home server');

  await office.click();
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await review.locator(`[${SERVER_PROFILE_SWITCH_COMMIT}]`).click();
  await navigation;
  await page.waitForFunction(() => window.__app?.ready === true);

  expect(nativeDialogs).toEqual([]);
  await expect(page).toHaveURL(/\?server_profiles=multiple&chat=session#chat$/);
  const banner = page.locator(`[${CONNECTION_BANNER}]`);
  await expect(banner).toContainText('Now using Office server.');
  await expect(page.locator(`[${CHAT_HISTORY_LANDING}]`)).toBeVisible();
  expect(
    await page.evaluate((key) => window.sessionStorage.getItem(key),
      SERVER_SWITCH_CONTINUITY_SESSION_KEY),
  ).toBeNull();

  await account.click();
  await expect(
    accountDialog.locator(`[${SERVER_PROFILE_ITEM}][aria-current="true"]`),
  ).toContainText('Office server');
  await page.keyboard.press('Escape');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator(`[${CONNECTION_BANNER}]`)).not.toContainText('Now using');
  await expect(page.locator(
    `[${SERVER_PROFILE_ITEM}][aria-current="true"]`,
  )).toContainText('Office server');
  expect(pageErrors).toEqual([]);
});

const COPY_DRAFT_TEXT = 'Private draft for this source server\nKeep this 😀 and the line breaks.';
declare global {
  interface Window {
    __serverSwitchDraftCopy?: { texts: string[]; resolve?: () => void; reject?: () => void };
  }
}

const switchToOtherSavedServer = async (page: Page): Promise<void> => {
  await page.locator(`[${ACCOUNT_MENU_TRIGGER}]`).click();
  const account = page.locator(`[${ACCOUNT_MENU_POPOVER}]`);
  await account.locator(`[${SERVER_PROFILE_ITEM}]:not([aria-current="true"])`).first().click();
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await account.locator(`[${SERVER_PROFILE_SWITCH_COMMIT}]`).click();
  await navigation;
  await page.waitForFunction(() => window.__app?.ready === true);
};

const withDraftCopyHandoff = async (
  { page, context }: { page: Page; context: BrowserContext },
  mode: string,
  run: (handoff: { dirty: Page; dialog: Locator; field: Locator; copy: Locator; commit: Locator }) => Promise<void>,
): Promise<void> => {
  const dirty = await context.newPage();
  const errors: Error[] = [];
  dirty.on('pageerror', error => errors.push(error));
  try {
    await dirty.setViewportSize({ width: 390, height: 844 });
    if (mode !== 'native') await dirty.addInitScript(clipboardMode => {
      const state = window.__serverSwitchDraftCopy = { texts: [] } as NonNullable<Window['__serverSwitchDraftCopy']>;
      const denied = (): never => { throw new Error('private clipboard policy detail'); };
      if (clipboardMode === 'navigator getter') {
        Object.defineProperty(window, 'navigator', { configurable: true, get: denied });
      } else {
        const clipboard = clipboardMode === 'missing' ? undefined
          : clipboardMode === 'writeText getter' ? Object.defineProperty({}, 'writeText', { get: denied })
            : { writeText: (text: string): Promise<void> => {
              state.texts.push(text);
              if (clipboardMode === 'synchronous throw') return denied();
              if (clipboardMode === 'pending') return new Promise<void>((resolve, reject) => {
                state.resolve = resolve; state.reject = () => reject(new Error('private clipboard policy detail'));
              });
              return Promise.reject(new Error('private clipboard policy detail'));
            } };
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          ...(clipboardMode === 'clipboard getter' ? { get: denied } : { value: clipboard }),
        });
      }
    }, mode);
    const base = `${HARNESS_URL}?server_profiles=multiple&chat=session`;
    await page.goto(`${base}#connections`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await dirty.goto(`${base}#chat/session/chat_1`);
    await dirty.waitForFunction(() => window.__app?.ready === true);
    await dirty.locator(`[${CHAT_INPUT}]`).fill(COPY_DRAFT_TEXT);
    await switchToOtherSavedServer(page);
    const dialog = dirty.locator(`[${SERVER_SWITCH_CONVERGENCE_DIALOG}]`);
    await expect(dialog).toBeVisible();
    await dirty.bringToFront();
    await run({ dirty, dialog, field: dialog.locator(`[${SERVER_SWITCH_CONVERGENCE_DRAFT}]`),
      copy: dialog.getByRole('button', { name: 'Copy draft', exact: true }),
      commit: dialog.locator(`[${SERVER_SWITCH_CONVERGENCE_COMMIT}]`) });
  } finally {
    await dirty.close({ runBeforeUnload: false });
    expect(errors, `uncaught draft-copy errors: ${errors.map(error => error.message).join(' | ')}`).toEqual([]);
  }
};

for (const mode of ['missing', 'navigator getter', 'clipboard getter', 'writeText getter', 'synchronous throw', 'rejection']) {
  test(`server-switch Copy draft selects the message when clipboard access fails with ${mode}`, async ({ page, context }) => {
    await withDraftCopyHandoff({ page, context }, mode, async ({ dirty, dialog, field, copy }) => {
      await copy.focus(); await dirty.keyboard.press('Enter');
      await expect(field).toHaveValue(COPY_DRAFT_TEXT);
      await expect(field).toHaveAttribute('readonly', '');
      await expect(field).toBeFocused();
      expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]))
        .toEqual([0, COPY_DRAFT_TEXT.length]);
      await expect(dialog.locator(`[${SERVER_SWITCH_CONVERGENCE_STATUS}]`)).toContainText('message is selected');
      await expect(dialog).not.toContainText('private clipboard policy detail');
      await expect(dirty).toHaveURL(/#chat\/session\/chat_1$/);
      await expect(dirty.locator(`[${SHELL_HOST}]`)).toHaveAttribute('inert', '');
      expect(await dirty.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
      expect(await dirty.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])))
        .not.toContain('Private draft for this source server');
    });
  });
}

for (const width of [375, 1280]) {
  test(`server-switch Copy draft writes the native clipboard from the keyboard at ${width}px`, async ({ page, context, browserName }) => {
    await withDraftCopyHandoff({ page, context }, 'native', async ({ dirty, dialog, copy }) => {
      await dirty.setViewportSize({ width, height: 900 });
      // WebKit writes during native activation and exposes only the read grant.
      const permissions = browserName === 'webkit' ? ['clipboard-read'] : ['clipboard-read', 'clipboard-write'];
      await context.grantPermissions(permissions, { origin: new URL(dirty.url()).origin });
      await copy.focus(); await dirty.keyboard.press('Enter');
      await expect(dialog.locator(`[${SERVER_SWITCH_CONVERGENCE_STATUS}]`)).toContainText('still not saved on the new server');
      await expect(copy).toBeFocused();
      expect(await dirty.evaluate(() => navigator.clipboard.readText())).toBe(COPY_DRAFT_TEXT);
      await expect(dirty).toHaveURL(/#chat\/session\/chat_1$/);
      expect(await dirty.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
      expect(await dirty.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}

test('server-switch Copy draft stays single-flight and preserves later keyboard focus after denial', async ({ page, context }) => {
  await withDraftCopyHandoff({ page, context }, 'pending', async ({ dirty, dialog, field, copy, commit }) => {
    await copy.focus(); await dirty.keyboard.press('Enter'); await dirty.keyboard.press('Enter');
    await expect(copy).toHaveAttribute('aria-busy', 'true');
    await expect(copy).toHaveAttribute('aria-disabled', 'true');
    await expect(copy).not.toHaveAttribute('disabled');
    expect(await dirty.evaluate(() => window.__serverSwitchDraftCopy?.texts)).toEqual([COPY_DRAFT_TEXT]);
    await commit.focus(); await dirty.evaluate(() => window.__serverSwitchDraftCopy?.reject?.());
    await expect(dialog.locator(`[${SERVER_SWITCH_CONVERGENCE_STATUS}]`)).toContainText('message is selected');
    await expect(commit).toBeFocused();
    expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]))
      .toEqual([0, COPY_DRAFT_TEXT.length]);
    await expect(copy).not.toHaveAttribute('aria-busy');
    await expect(copy).not.toHaveAttribute('aria-disabled');
  });
});

for (const outcome of ['rejection', 'timeout']) {
  test(`server-switch Copy draft preserves a later manual selection after ${outcome}`, async ({ page, context }) => {
    await withDraftCopyHandoff({ page, context }, 'pending', async ({ dirty, dialog, field, copy }) => {
      await copy.focus(); await dirty.keyboard.press('Enter');
      await field.evaluate((node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(2, 14, 'backward'); });
      if (outcome === 'rejection') await dirty.evaluate(() => window.__serverSwitchDraftCopy?.reject?.());
      await expect(copy).not.toHaveAttribute('aria-busy');
      expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection]))
        .toEqual([2, 14, 'backward']);
      await expect(field).toBeFocused();
      await expect(field).toHaveValue(COPY_DRAFT_TEXT);
      await expect(dialog.locator(`[${SERVER_SWITCH_CONVERGENCE_STATUS}]`)).toContainText('could not copy');
      expect(await dirty.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
    });
  });
}

test('server-switch Copy draft selects a stalled write and ignores its late success', async ({ page, context }) => {
  await withDraftCopyHandoff({ page, context }, 'pending', async ({ dirty, dialog, field, copy, commit }) => {
    await copy.focus(); await dirty.keyboard.press('Enter');
    await expect(dialog.locator(`[${SERVER_SWITCH_CONVERGENCE_STATUS}]`)).toContainText('message is selected');
    await expect(field).toBeFocused();
    expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]))
      .toEqual([0, COPY_DRAFT_TEXT.length]);
    await commit.focus(); await dirty.evaluate(() => window.__serverSwitchDraftCopy?.resolve?.());
    await expect(commit).toBeFocused();
    await expect(dialog.locator(`[${SERVER_SWITCH_CONVERGENCE_STATUS}]`)).toContainText('message is selected');
  });
});

for (const outcome of ['resolve', 'reject'] as const) {
  test(`server-switch Copy draft ignores a late ${outcome} after the source server is restored`, async ({ page, context }) => {
    await withDraftCopyHandoff({ page, context }, 'pending', async ({ dirty, dialog, copy }) => {
      await copy.focus(); await dirty.keyboard.press('Enter');
      await switchToOtherSavedServer(page);
      await expect(dialog).toHaveCount(0);
      await dirty.bringToFront();
      const input = dirty.locator(`[${CHAT_INPUT}]`);
      await input.focus();
      await dirty.evaluate(result => window.__serverSwitchDraftCopy?.[result]?.(), outcome);
      await expect(input).toBeFocused(); await expect(input).toHaveValue(COPY_DRAFT_TEXT);
      await expect(dirty.locator(`[${SHELL_HOST}]`)).not.toHaveAttribute('inert');
      expect(await dirty.evaluate(() => window.__app.rpcCallCount('chat.send'))).toBe(0);
    });
  });
}

test('a deliberate server switch converges clean and dirty sibling tabs without crossing work', async ({ page, context }) => {
  const clean = await context.newPage();
  const dirty = await context.newPage();
  const working = await context.newPage();
  const errors: Error[] = [];
  const dialogs: string[] = [];
  for (const tab of [page, clean, dirty, working]) {
    tab.on('pageerror', (error) => errors.push(error));
    tab.on('dialog', async (dialog) => {
      dialogs.push(dialog.type());
      await dialog.dismiss();
    });
    await tab.setViewportSize({ width: 390, height: 844 });
  }

  try {
    const base = `${HARNESS_URL}?server_profiles=multiple&chat=session`;
    // The harness creates the second profile on first boot. Open sequentially
    // so that one tab cannot observe another tab's short-lived setup pointer;
    // the product journey itself begins only after all three boot on home.
    await page.goto(`${base}#connections`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await clean.goto(`${base}#chat/session/chat_1/answer/source-message`);
    await clean.waitForFunction(() => window.__app?.ready === true);
    await dirty.goto(`${base}#chat/session/chat_1`);
    await dirty.waitForFunction(() => window.__app?.ready === true);
    await working.goto(`${base}#chat/session/chat_1`);
    await working.waitForFunction(() => window.__app?.ready === true);

    const sourceDraft = 'Private source-server thought from the sibling tab';
    await dirty.locator(`[${CHAT_INPUT}]`).fill(sourceDraft);
    await working.locator(`[${CHAT_INPUT}]`).fill(
      'Prepare a source-server result before I switch',
    );
    await working.locator(`[${CHAT_SEND}]`).click();
    // The send acknowledgement settles before the accepted turn completes.
    await expect(working.locator(`[${CHAT_ANSWER_WAITING}]`)).toBeVisible();
    await expect(working.locator(`[${CHAT_SEND}]`)).toBeDisabled();

    const account = page.locator(`[${ACCOUNT_MENU_TRIGGER}]`);
    await account.click();
    const accountDialog = page.locator(`[${ACCOUNT_MENU_POPOVER}]`);
    const office = accountDialog
      .locator(`[${SERVER_PROFILE_ITEM}]`)
      .filter({ hasText: 'Office server' });
    await office.click();
    const review = accountDialog.locator(`[${SERVER_PROFILE_SWITCH_CONFIRM}]`);
    await expect(review).toBeVisible();

    const sourceNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    const cleanNavigation = clean.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await review.locator(`[${SERVER_PROFILE_SWITCH_COMMIT}]`).click();
    await Promise.all([sourceNavigation, cleanNavigation]);
    await Promise.all([
      page.waitForFunction(() => window.__app?.ready === true),
      clean.waitForFunction(() => window.__app?.ready === true),
    ]);
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .toContainText('Now using Office server.');

    // A clean sibling follows the durable pointer immediately, scrubs the
    // source record identity, and does not claim the initiating tab's receipt.
    await expect(clean).toHaveURL(/#chat$/);
    await expect(clean.locator(`[${SERVER_SWITCH_CONVERGENCE}]`)).toHaveCount(0);
    await expect(clean.locator(`[${CONNECTION_BANNER}]`)).not.toContainText('Now using');
    expect(
      await clean.evaluate((key) => window.sessionStorage.getItem(key),
        SERVER_SWITCH_CONTINUITY_SESSION_KEY),
    ).toBeNull();

    // A sibling with an accepted, unsettled turn does not silently follow the
    // pointer. It can recheck in place; leaving remains an explicit unknown-
    // outcome decision and the receipt stays with the source server.
    const workingHandoff = working.locator(
      `[${SERVER_SWITCH_CONVERGENCE_DIALOG}]`,
    );
    await expect(workingHandoff).toBeVisible();
    await expect(workingHandoff).toContainText(
      'The first server is still working',
    );
    await expect(workingHandoff).toContainText(
      'Whatever happened stays on the first server',
    );
    const checkWork = workingHandoff.locator(
      `[${SERVER_SWITCH_CONVERGENCE_CHECK}]`,
    );
    await expect(checkWork).toHaveText('Check status');
    await expect(workingHandoff.locator(
      `[${SERVER_SWITCH_CONVERGENCE_COMMIT}]`,
    )).toHaveText('Switch, and check later');
    await checkWork.click();
    await expect(workingHandoff.locator(
      `[${SERVER_SWITCH_CONVERGENCE_STATUS}]`,
    )).toContainText('Work is still finishing on');

    await working.evaluate(() => window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'chat.message_complete',
        session_id: 'chat_1',
        turn_id: 'turn_plan_continue_1',
        final: {
          id: 'msg_source_work_complete',
          session_id: 'chat_1',
          role: 'assistant',
          content: 'The source-server work finished here.',
          target_server: 'self',
          picker_at_send: {
            display_name: 'This server',
            signature: {
              server_kind: 'recued',
              version: 'test',
              instance_id: 'server-switch-source',
            },
          },
          model_used: {
            provider: 'openai',
            model_id: 'gpt-4.1-mini',
          },
          contributor: 'model',
          ts: 1_700_000_000_040,
        },
        cursor: 40,
      },
    }));
    await checkWork.click();
    await expect(workingHandoff.locator(
      `[${SERVER_SWITCH_CONVERGENCE_STATUS}]`,
    )).toContainText('The request settled on');
    await expect(workingHandoff.locator(
      `[${SERVER_SWITCH_CONVERGENCE_CHECK}]`,
    )).toHaveCount(0);
    const workingContinue = workingHandoff.locator(
      `[${SERVER_SWITCH_CONVERGENCE_COMMIT}]`,
    );
    await expect(workingContinue).toHaveText('Reload this tab');
    const workingNavigation = working.waitForNavigation({
      waitUntil: 'domcontentloaded',
    });
    await workingContinue.click();
    await workingNavigation;
    await working.waitForFunction(() => window.__app?.ready === true);
    await expect(working).toHaveURL(/#chat$/);
    await expect(working.locator(`[${CONNECTION_BANNER}]`))
      .not.toContainText('Now using');

    // A dirty sibling remains on its source URL behind an alertdialog. The
    // draft is readable/copyable in memory but never placed in target Chat.
    const handoff = dirty.locator(`[${SERVER_SWITCH_CONVERGENCE_DIALOG}]`);
    await expect(handoff).toBeVisible();
    await expect(handoff).toHaveAccessibleName('Server changed in another tab');
    await expect(handoff).toHaveAccessibleDescription(
      /This tab is still showing.+Another tab selected.+Chat message.+Chats, records, runs and links belong to one server and stay there/,
    );
    await expect(handoff).toContainText('wss://alice.recued.cloud:8443/ws');
    await expect(handoff).toContainText('Office server');
    await expect(handoff).toContainText('never move it to another server');
    await expect(dirty.locator(`[${SERVER_SWITCH_CONVERGENCE_DRAFT}]`))
      .toHaveValue(sourceDraft);
    await expect(dirty).toHaveURL(/#chat\/session\/chat_1$/);
    const continueSwitch = handoff.locator(`[${SERVER_SWITCH_CONVERGENCE_COMMIT}]`);
    await expect(dirty.locator(`[${SHELL_HOST}]`)).toHaveAttribute('inert', '');
    await dirty.keyboard.press('Escape');
    await expect(handoff).toBeVisible();
    await expect(handoff.locator(`[${SERVER_SWITCH_CONVERGENCE_STATUS}]`))
      .toContainText('Finish changing servers');
    await dirty.keyboard.press('Shift+Tab');
    await expect(continueSwitch).toBeFocused();
    const target = await continueSwitch.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    await dirty.screenshot({
      path: test.info().outputPath(`full-app-multi-tab-server-switch-draft-boundary-mobile.png`),
      fullPage: false,
    });

    const dirtyNavigation = dirty.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await continueSwitch.click();
    await dirtyNavigation;
    await dirty.waitForFunction(() => window.__app?.ready === true);

    await expect(dirty).toHaveURL(/#chat$/);
    await expect(dirty.locator(`[${SERVER_SWITCH_CONVERGENCE}]`)).toHaveCount(0);
    await expect(dirty.locator(`[${CHAT_HISTORY_LANDING}]`)).toBeVisible();
    await expect(dirty.locator(`[${CHAT_INPUT}]`)).toHaveCount(0);
    await expect(dirty.locator('body')).not.toContainText(sourceDraft);
    await expect(dirty.locator(`[${CONNECTION_BANNER}]`)).not.toContainText('Now using');
    expect(dialogs).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([clean.close(), dirty.close(), working.close()]);
  }
});
