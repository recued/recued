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
const STARTUP_RECOVERY_RETURN_RECEIPT_COPY =
  'Startup recovered. Secure access is still saved, and your page is ready.';
const STARTUP_RECOVERY_DRAFT_RETURN_RECEIPT_COPY =
  'Startup recovered. Secure access is still saved, and your unsent Chat draft is ready.';
const STARTUP_RELOAD_RECOVERY_SESSION_KEY =
  'recued.webclient.startup-reload-recovery.v1';
const RECOVERY_REENTRY_SESSION_KEY =
  'recued.webclient.recovery-reentry.v1';
const SERVER_SWITCH_CONTINUITY_SESSION_KEY =
  'recued.webclient.server-switch-continuity.v1';

const SHELL_HOST = 'data-recued-webclient-shell';
const SHELL_CONTENT = 'data-recued-webclient-content';
const SHELL_TOPBAR = 'data-recued-webclient-topbar';
const ATTENTION_TOPBAR = 'data-recued-attention-topbar';
const ATTENTION_DIALOG = 'data-recued-attention-dialog';
const ATTENTION_CLOSE = 'data-recued-attention-close-button';
const CONNECTION_BANNER = 'data-recued-connection-banner';
const CONNECTION_BANNER_ACTION = 'data-recued-connection-banner-action';
const CONNECTION_STATUS_ANNOUNCER = 'data-recued-connection-status-announcer';
const ACCOUNT_MENU_TRIGGER = 'data-recued-account-menu-trigger';
const ACCOUNT_MENU_BADGE = 'data-recued-account-menu-badge';
const ACCOUNT_MENU_POPOVER = 'data-recued-account-menu-popover';
const ACCOUNT_MENU_CLOSE = 'data-recued-account-menu-close';
const ACCOUNT_MENU_SETTINGS = 'data-recued-account-menu-settings';
const ACCOUNT_MENU_RECOVERY = 'data-recued-account-menu-recovery';
const ACCOUNT_MENU_RECOVERY_STEPS = 'data-recued-account-menu-recovery-steps';
const ACCOUNT_MENU_SERVER_SLOT = 'data-recued-account-menu-server-slot';
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
const CHAT_SESSION_ACTIONS = 'data-recued-chat-route-session-actions';
const CHAT_HISTORY_LANDING = 'data-recued-chat-route-history-landing';
const CHAT_HISTORY_CONTINUE = 'data-recued-chat-route-history-continue';
const CHAT_HISTORY_SEARCH = 'data-recued-chat-route-history-search';
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

test('the Attention bell is a focused, responsive queue with an exact handoff', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?attention=pending`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const host = page.locator(`[${ATTENTION_TOPBAR}]`);
  const bell = page.getByRole('button', {
    name: '2 decisions need your attention',
  });
  await expect(bell).toBeVisible();
  await expect(bell.locator('.top-bar-attention-bell svg')).toHaveCount(1);
  expect(await host.evaluate((node) => {
    const styles = getComputedStyle(node);
    return {
      position: styles.position,
      paddingLeft: styles.paddingLeft,
      borderBottomWidth: styles.borderBottomWidth,
    };
  })).toEqual({
    position: 'static',
    paddingLeft: '0px',
    borderBottomWidth: '0px',
  });

  await bell.click();
  const dialog = page.locator(`[${ATTENTION_DIALOG}]`);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName('Attention');
  await expect(dialog).toContainText('2 decisions are waiting for you.');
  await expect(dialog).toContainText('Connected action · Answer to continue');
  await expect(dialog).toContainText(
    'Approval · HubSpot contact update · Changes data',
  );
  await expect(dialog).not.toContainText('Other notifications');
  await expect(dialog.getByRole('button', {
    name: 'Approve: Send the customer follow-up?',
  })).toBeVisible();
  await expect(dialog.getByRole('button', {
    name: "Approve: Update Acme's account owner in HubSpot",
  })).toBeVisible();
  await expect(
    dialog.getByRole('link', { name: 'Open full queue' }),
  ).toBeVisible();
  await expect(page.locator(`[${ATTENTION_CLOSE}]`)).toBeFocused();

  const geometry = await dialog.evaluate((node) => {
    const rect = node.parentElement!.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 0.5);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 0.5);
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-attention-mobile.png`,
    fullPage: false,
  });

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(bell).toBeFocused();

  await bell.click();
  await page.mouse.click(380, 820);
  await expect(dialog).toHaveCount(0);

  await bell.click();
  await dialog.getByRole('link', { name: 'Open full queue' }).click();
  await expect(page).toHaveURL(/#approvals$/);
  await expect(page.locator('[data-recued-approvals-route]')).toBeVisible();
  await expect(page.locator(`[${ATTENTION_DIALOG}]`)).toHaveCount(0);
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
  await expect(account).toHaveAccessibleName('Account and server profiles');
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
  await expect(renameForm.locator(`[${SERVER_PROFILE_RENAME_INPUT}]`)).toBeFocused();
  await renameForm.locator(`[${SERVER_PROFILE_RENAME_INPUT}]`).fill('Work server');
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

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(account).toBeFocused();

  await page.evaluate(() => window.__app.fireState('reconnecting'));
  await expect(announcer).toContainText('reconnecting automatically');
  await expect(banner).toHaveAttribute('data-state', 'ok');

  await page.evaluate(() => {
    window.__app.setServerAvailable(false);
    window.__app.fireState('closed');
  });
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('role', 'alert');
  await expect(banner).toContainText(
    'Can’t reach the current server. Recued will keep trying.',
  );
  await expect(
    banner.locator(`[${CONNECTION_BANNER_ACTION}]`),
  ).toHaveText('Review server profiles');
  await expect(account).toHaveAccessibleName(
    'Account and server profiles. Current server is not reachable',
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
  await expect(recovery).toContainText('switch to another saved profile');
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
    path: `${ARTIFACTS}/full-app-account-server-recovery-mobile.png`,
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
  await expect(account).toHaveAccessibleName('Account and server profiles');
  await expect(recovery).toBeHidden();
  await expect(dialog).toBeFocused();
  await expect(currentProfile).not.toHaveAttribute('data-unreachable', 'true');
  await expect(dialog).toContainText('Work server');

  await dialog.locator(`[${ACCOUNT_MENU_SETTINGS}]`).click();
  await expect(page).toHaveURL(/#settings\/account$/);
  await page.waitForFunction(() => window.__app.activeRoute() === 'settings');
  await expect(dialog).toBeHidden();
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
  await expect(review).toContainText('Your unsent Chat draft stays only in this tab');
  await expect(review).toContainText(
    'Server-specific chats, records, runs, and detail links stay on their original server',
  );
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-deliberate-server-switch-mobile.png`,
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
    await expect(working.locator(`[${CHAT_SEND}]`)).toHaveText('Sending...');

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
      'Work is still finishing on the original server',
    );
    await expect(workingHandoff).toContainText(
      'Any outcome or receipt stays on the original server',
    );
    const checkWork = workingHandoff.locator(
      `[${SERVER_SWITCH_CONVERGENCE_CHECK}]`,
    );
    await expect(checkWork).toHaveText('Check status');
    await expect(workingHandoff.locator(
      `[${SERVER_SWITCH_CONVERGENCE_COMMIT}]`,
    )).toHaveText('Switch and check later');
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
      /This tab is still showing.+Another tab selected.+Your unsent Chat draft.+Server-specific chats, records, runs, and detail links stay on their original server/,
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
      .toContainText('Finish switching this tab');
    await dirty.keyboard.press('Shift+Tab');
    await expect(continueSwitch).toBeFocused();
    const target = await continueSwitch.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    await dirty.screenshot({
      path: `${ARTIFACTS}/full-app-multi-tab-server-switch-draft-boundary-mobile.png`,
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
    'This tab reloaded, but this browser’s saved access still needs repair.',
  );
  await expect(repair).toContainText(
    'exact page you opened is still selected',
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
    path: `${ARTIFACTS}/full-app-cold-start-credential-repair-mobile.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await confirmRepair.click();

  const pairForm = page.locator('#webclient-pair-code-input-form');
  await expect(pairForm).toBeVisible();
  const notice = pairForm.locator(`[${PAIR_REAUTH_NOTICE}]`);
  await expect(notice).toContainText('Unreadable local access cleared');
  await expect(notice).toContainText(
    'This browser could not unlock its saved sign-in',
  );
  await expect(notice).not.toContainText(
    "Your server no longer accepts this browser's saved access",
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
    'This tab reloaded, but this browser’s saved access still needs repair.',
  );
  await expect(repair).toContainText(
    'exact page you opened is still selected',
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
    path: `${ARTIFACTS}/full-app-partial-local-state-repair-mobile.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await confirmRepair.click();

  const pairForm = page.locator('#webclient-pair-code-input-form');
  await expect(pairForm).toBeVisible();
  const notice = pairForm.locator(`[${PAIR_REAUTH_NOTICE}]`);
  await expect(notice).toContainText('Incomplete browser setup cleared');
  await expect(notice).toContainText(
    'A previous setup stopped before every local access detail was saved.',
  );
  await expect(notice).not.toContainText(
    "Your server no longer accepts this browser's saved access",
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
  await expect(receipt).not.toContainText('Startup recovered');
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
    path: `${ARTIFACTS}/full-app-persistent-storage-recovery-mobile.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await retry.click();
  await expect(
    page.getByRole('region', { name: 'Make room for browser storage' }),
  ).toBeVisible();
  await expect(recovery.getByRole('alert')).toContainText(
    'Storage is still full.',
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
    'exact page you opened is still selected',
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
    path: `${ARTIFACTS}/full-app-persistent-storage-reload-still-blocked-mobile.png`,
    fullPage: true,
  });

  await retry.click();
  await expect(recovery.getByRole('alert')).toContainText(
    'Storage is still full.',
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
  await expect(receipt).not.toContainText('Startup recovered');
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
    `http://localhost:4319/full-app-harness.html${journeyQuery}&${resumeQuery}#chat/session/chat_1`;
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
    path: `${ARTIFACTS}/full-app-secure-access-handoff-mobile.png`,
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
    'Use a trusted address that starts with https://.',
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
    'Your pairing code is ready too. Continue with your recovery key.',
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
    path: `${ARTIFACTS}/full-app-secure-access-arrival-mobile.png`,
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
    'Browser paired. Secure access is saved here, and your page is ready.',
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
    path: `${ARTIFACTS}/full-app-pair-success-return-mobile.png`,
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
    .not.toContainText('Browser paired');

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
    .not.toContainText('Browser paired');
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
    path: `${ARTIFACTS}/full-app-pair-refresh-continuity-mobile.png`,
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
    .not.toContainText('Browser paired');
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
      .not.toContainText('Browser paired');
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
      path: `${ARTIFACTS}/full-app-multi-tab-pair-sibling-mobile.png`,
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
        server_public_key: 'spki-base64',
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
    `${HARNESS_URL}?journey=multi-tab-credentials&pause_pair=1&chat=session&keep=sibling%20tab&keep=sibling+two#chat/session/chat_1`;

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
      'Saved access changed in another tab',
    );
    await expect(siblingNotice).toContainText(
      'This tab stopped using the old session.',
    );
    await expect(siblingNotice).toContainText(
      'Your current page and unsent Chat draft are held in this tab.',
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
      'return to your current page and unsent Chat draft automatically when the other tab finishes',
    );
    await expect(siblingInterrupted).toContainText(
      'Your recovery-key entry stays here',
    );
    await expect(siblingPairingCode).toHaveValue('');
    await expect(siblingRecoveryWord).toHaveValue('zoo');
    await expect(siblingRecoveryWord).toBeFocused();
    expect(await sibling.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(0);
    await sibling.screenshot({
      path: `${ARTIFACTS}/full-app-guided-repair-sibling-winner-mobile.png`,
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
      .not.toContainText('Browser paired');
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .toHaveAttribute('data-state', 'restored');
    await expect(page.locator(`[${CONNECTION_BANNER}]`))
      .toContainText('Reconnected');
    expect(await page.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(1);
    expect(await sibling.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(0);
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
        server_public_key: 'spki-base64',
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
      'Recued will offer a safe takeover if it does not finish.',
    );

    await expect(siblingInterrupted).toHaveAttribute(
      PAIR_TAKEOVER_READY,
      '',
    );
    await expect(siblingInterrupted).toContainText(
      'The other tab is taking longer',
    );
    await expect(siblingInterrupted).toContainText(
      'Recued lets only one continue and returns the others automatically',
    );
    await expect(siblingInterrupted).toContainText(
      'recovery key, current page, and unsent Chat draft stay here',
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
      path: `${ARTIFACTS}/full-app-stalled-sibling-safe-takeover-mobile.png`,
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
      .not.toContainText('Browser paired');
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
        server_public_key: 'spki-base64',
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
    `${HARNESS_URL}?journey=multi-tab-transition&takeover_delay_ms=700&pair_response_delay_ms=3000&chat=session&keep=first%20contender#chat/session/chat_1`;
  const secondUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&takeover_delay_ms=700&pair_response_delay_ms=3000&chat=session&keep=second%20contender#chat/session/chat_1`;

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
    await Promise.all([
      expect(sourceForm).toBeVisible(),
      expect(firstForm).toBeVisible(),
      expect(secondForm).toBeVisible(),
    ]);

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
    await Promise.all([firstTakeover.click(), secondTakeover.click()]);

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
      'If it succeeds, other open tabs will adopt its saved access without sending their pairing codes',
    );
    const winnerProgress = winnerForm.getByRole('button', {
      name: 'Reconnecting from this tab…',
    });
    await expect(winnerProgress).toBeDisabled();
    await expect(winnerProgress).toBeFocused();
    await expect(loserForm).toHaveAttribute('aria-busy', 'true');
    await expect(loserNotice).not.toHaveAttribute(PAIR_TAKEOVER_OWNER, '');
    await expect(loserNotice).toContainText('Choosing one tab safely');
    await expect(loserNotice).toContainText(
      'return automatically without sending its pairing code',
    );
    const loserProgress = loserForm.getByRole('button', {
      name: 'Choosing one tab…',
    });
    await expect(loserProgress).toBeDisabled();
    await expect(loserProgress).toBeFocused();

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
        .not.toContainText('Browser paired');
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
        server_public_key: 'spki-base64',
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
    `${HARNESS_URL}?journey=multi-tab-transition&takeover_delay_ms=700&pair_response_delay_ms=3000&fail_first_takeover_globally=1&chat=session&keep=first%20succession#chat/session/chat_1`;
  const secondUrl =
    `${HARNESS_URL}?journey=multi-tab-transition&takeover_delay_ms=700&pair_response_delay_ms=3000&fail_first_takeover_globally=1&chat=session&keep=second%20succession#chat/session/chat_1`;

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
    await Promise.all([
      expect(sourceForm).toBeVisible(),
      expect(firstForm).toBeVisible(),
      expect(secondForm).toBeVisible(),
    ]);

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
      firstForm.getByRole('button', { name: 'Reconnect in this tab' }).click(),
      secondForm.getByRole('button', { name: 'Reconnect in this tab' }).click(),
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
        .not.toContainText('Browser paired');
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
        server_public_key: 'spki-base64',
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
    await Promise.all([
      expect(sourceForm).toBeVisible(),
      expect(firstForm).toBeVisible(),
      expect(secondForm).toBeVisible(),
    ]);

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
      firstForm.getByRole('button', { name: 'Reconnect in this tab' }).click(),
      secondForm.getByRole('button', { name: 'Reconnect in this tab' }).click(),
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
    await expect(recoveryNotice).toContainText('This tab needs attention');
    await expect(recoveryNotice).toContainText('only one retry to manage');
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
      'Continue in the tab that needs attention',
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

    await expect(successorNotice).toContainText('Recovery moved to this tab');
    await expect(successorNotice).toContainText('only safe successor');
    if (sourceIsSuccessor) {
      await expect(successorNotice).toContainText(
        'will not contact the pairing endpoint again',
      );
    }
    await expect(successorForm.locator('[data-error]')).toBeVisible();
    const successorAction = successorForm.getByRole('button', {
      name: sourceIsSuccessor
        ? 'Finish saving access'
        : 'Continue recovery here',
    });
    await expect(successorAction).toBeEnabled();
    await expect(successorAction).toBeFocused();

    await expect(passiveNotice).toContainText(
      'Recovery continued in another tab',
    );
    await expect(passiveNotice).toContainText('remains safely paused');
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
        server_public_key: 'spki-base64',
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
    await expect(reentryNotice).toContainText('Recovery resumed in this tab');
    await expect(reentryNotice).toContainText(
      'You do not need to wait for that page.',
    );
    await expect(reentryNotice).toContainText(
      'The exact page you were returning to is still selected.',
    );
    await expect(reentryNotice).toContainText(
      'Pairing details are not restored',
    );
    await expect(reentryNotice).toContainText(
      're-enter any missing server address, pairing code, and recovery key',
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
      .not.toContainText('Browser paired');
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
        server_public_key: 'spki-base64',
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
    await expect(arrivalCheck).toHaveText('Checking saved access…');
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
      path: `${ARTIFACTS}/full-app-mid-transition-wait-mobile.png`,
      fullPage: true,
    });

    // A real reload while the source still owns the transition lock must land
    // on the same neutral check, never a stale pair/corruption surface.
    await arrival.reload();
    await arrival.waitForTimeout(300);
    await expect(arrival).toHaveURL(arrivalUrl);
    await expect(arrivalCheck).toHaveText('Checking saved access…');
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
      .not.toContainText('Browser paired');
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
      path: `${ARTIFACTS}/full-app-mid-transition-arrival-mobile.png`,
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
        server_public_key: 'spki-base64',
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
      'will not contact the pairing endpoint again',
    );
    await expect(
      sourceForm.locator('#webclient-pair-code-input-status'),
    ).not.toContainText('Reload');
    const finish = sourceForm.getByRole('button', {
      name: 'Finish saving access',
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
      'This tab reloaded, but this browser’s saved access still needs repair.',
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
      path: `${ARTIFACTS}/full-app-credential-repair-reload-sibling-mobile.png`,
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
      path: `${ARTIFACTS}/full-app-interrupted-pair-save-mobile.png`,
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
      'Access saved in another tab',
    );
    await expect(arrivalStartupRecovery).toContainText(
      'Finish opening this tab',
    );
    await expect(arrivalStartupRecovery).toContainText(
      'Pairing is already finished.',
    );
    await expect(arrivalStartupRecovery).toContainText(
      'Your exact page is still held in this tab.',
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
      path: `${ARTIFACTS}/full-app-sibling-converged-startup-recovery-mobile.png`,
      fullPage: true,
    });

    await arrivalRetry.click();
    const arrivalTriage = arrival.locator(`[${STARTUP_FAILURE_TRIAGE}]`);
    await expect(arrivalTriage).toBeVisible();
    await expect(arrivalTriage).toHaveAttribute('role', 'region');
    await expect(arrivalTriage).toContainText('Access saved in another tab');
    await expect(arrivalTriage).toContainText(
      'Another tab already finished saving secure access',
    );
    await expect(arrivalTriage).toContainText(
      'Recued can’t reach your server',
    );
    await expect(arrivalTriage).toContainText('Pairing is still complete.');
    await expect(arrivalTriage).toContainText(
      'Only this tab is retrying startup.',
    );
    await expect(arrivalTriage).toContainText(
      'completed pairing does not need to be repeated',
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
      path: `${ARTIFACTS}/full-app-sibling-converged-repeated-startup-mobile.png`,
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
      'Saved browser access: Verified present',
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
    ).toContainText('Safe diagnostic copied');
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
      'Access changed while this tab was recovering',
    );
    await expect(arrivalNotice).toContainText(
      'cleared or replaced the saved access this startup retry was using',
    );
    await expect(arrivalNotice).toContainText(
      'stopped that stale retry before it could open your page',
    );
    await expect(arrivalNotice).toContainText(
      'Your current page is held in this tab.',
    );
    await expect(arrivalForm).not.toContainText('Pairing is still complete');
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
      path: `${ARTIFACTS}/full-app-sibling-triage-credential-loss-mobile.png`,
      fullPage: true,
    });
    expect(await arrival.evaluate(() => window.__app.pairSubmitCount?.()))
      .toBe(0);

    await arrivalRecoveryWord.fill(recoveryKey);
    await arrivalForm.getByRole('button', {
      name: 'Reconnect this browser',
    }).click();
    const arrivalFinish = arrivalForm.getByRole('button', {
      name: 'Finish saving access',
    });
    await expect(arrivalFinish).toBeVisible();
    await expect(arrivalFinish).toBeFocused();
    await expect(arrivalForm).toContainText('Server pairing is complete');
    await expect(arrivalForm).toContainText(
      'will not contact the pairing endpoint again',
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
      .not.toContainText('Browser paired');
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
  await expect(notice).toContainText('Saved access needs attention');
  await expect(notice).toContainText(
    'Your current page and unsent Chat draft are held in this tab.',
  );
  await expect(notice).toContainText('return where you left off');
  await expect(
    pairForm.locator('#webclient-pair-code-input-server-url'),
  ).toHaveValue('https://alice.recued.cloud:8443');
  await expect(pairForm).toContainText('recued pair');
  await expect(
    pairForm.getByRole('button', { name: 'Generate a new one' }),
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
    path: `${ARTIFACTS}/full-app-reauth-guided-repair-mobile.png`,
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
  await expect(error).toContainText("doesn't match the one your server has");
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
    'Review the server address or re-enter the recovery key before retrying.',
  );
  expect(await page.evaluate(() => window.__app.pairSubmitCount?.())).toBe(1);
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-recovery-key-correction-mobile.png`,
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
    'Details to share with the server owner',
    { exact: true },
  )).toBeVisible();
  await diagnostic.getByText(
    'Details to share with the server owner',
    { exact: true },
  ).click();
  await expect(diagnostic).toHaveAttribute('open', '');
  await expect(diagnosticSummary).toContainText(
    'Latest server origin tried: https://alice.recued.cloud:8443',
  );
  await expect(diagnosticSummary).toContainText(
    'Origin comparison: matches previously paired origin',
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
    path: `${ARTIFACTS}/full-app-recovery-key-triage-narrow.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });

  await correction.getByRole('button', {
    name: 'I confirmed the server — I can’t find the key',
  }).click();
  const pausedForm = page.getByRole('form', {
    name: 'Recovery paused safely',
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
    'Your exact page and unsent Chat draft are still held here.',
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
    'Safe details for the server owner',
    { exact: true },
  )).toBeVisible();
  await expect(pausedDiagnosticSummary).toContainText(
    'Requested owner check: confirm this server origin and whether the server was replaced or reset; do not request the recovery key',
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
    path: `${ARTIFACTS}/full-app-recovery-key-safe-stop-narrow.png`,
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
        server_public_key: 'spki-base64',
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
    name: 'Recovery paused safely',
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
  form = page.getByRole('form', { name: 'Recovery still paused' });
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
  await expect(form).not.toContainText('Format-valid key rejections');
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
  form = page.getByRole('form', { name: 'Review the current server' });
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
  form = page.getByRole('form', { name: 'Review the current server' });
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
    name: 'Review current server',
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
    path: `${ARTIFACTS}/full-app-replacement-server-review-narrow.png`,
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await replacementReview.getByRole('button', {
    name: 'Start fresh on this server',
  }).click();

  form = page.getByRole('form', { name: 'Set up the current server' });
  const replacementConfirmed =
    form.locator(`[${PAIR_REPLACEMENT_CONFIRMED}]`);
  await expect(replacementConfirmed).toContainText(
    'Fresh start confirmed for this server',
  );
  await expect(replacementConfirmed).toContainText(
    'The old server’s key cannot be entered in this path',
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
    name: 'Pair with this fresh server',
  });
  await expect(pairFreshServer).toBeEnabled();
  await pairFreshServer.click();

  await expect(page).toHaveURL(exactUrl);
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  const receipt = page.locator(`[${CONNECTION_BANNER}]`);
  await expect(receipt).toHaveAttribute('role', 'status');
  await expect(receipt).toHaveAttribute('data-state', 'restored');
  await expect(receipt).toContainText('Fresh pairing verified.');
  await expect(receipt).toContainText(
    'Data from the previous server was not restored.',
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
    path: `${ARTIFACTS}/full-app-replacement-server-verified-return-mobile.png`,
    fullPage: true,
  });

  // A normal reload uses the durable verified pair, preserves the exact route,
  // and does not replay either the ceremony or its one-shot receipt.
  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(exactUrl);
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  await expect(page.getByRole('form', {
    name: 'Review the current server',
  })).toHaveCount(0);
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .toHaveAttribute('data-state', 'ok');
  await expect(page.locator(`[${CONNECTION_BANNER}]`))
    .not.toContainText('Fresh pairing verified');
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
  await expect(startupRecovery).toContainText('Secure access saved');
  await expect(startupRecovery).toContainText(
    'You do not need to pair this browser again.',
  );
  await expect(startupRecovery).toContainText(
    'exact page and unsent Chat draft',
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
    path: `${ARTIFACTS}/full-app-post-pair-startup-recovery-mobile.png`,
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
  await expect(receipt).not.toContainText('Browser paired');
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
    path: `${ARTIFACTS}/full-app-startup-recovery-confirmation-mobile.png`,
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
  await expect(receipt).not.toContainText('Startup recovered');

  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(target);
  await page.waitForFunction(() => window.__app.activeRoute() === 'chat');
  await expect(receipt).toHaveAttribute('data-state', 'ok');
  await expect(receipt).not.toContainText('Startup recovered');
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
  await expect(triage).toContainText('Startup still needs attention');
  await expect(triage).toContainText('Recued can’t reach your server');
  await expect(triage).toContainText(
    'exact page and unsent Chat draft',
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
    'URL paths, query parameters, and fragments are not included',
  );
  await expect(diagnosticSummary).not.toContainText(draft);
  await expect(diagnosticSummary).not.toContainText('abandon');
  await expect(diagnosticSummary).not.toContainText('#chat/session');
  await expect(diagnosticSummary).not.toContainText('/ws');

  const reviewedSummary = await diagnosticSummary.textContent();
  await diagnostic.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_COPY}]`).click();
  await expect(
    diagnostic.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_STATUS}]`),
  ).toContainText('Safe diagnostic copied');
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
    .not.toContainText('Browser paired');
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
  await expect(triage).toContainText('Startup needs attention');
  await expect(triage).toContainText('Recued can’t reach your server');
  await expect(triage).toContainText('Your saved access is still here.');
  await expect(triage).toContainText('exact page you opened');
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
    .toContainText('still can’t reach your server');
  expect(await page.evaluate(() => window.__app.startupAttemptCount?.()))
    .toBe(2);

  const diagnosticAction = triage.locator(
    `[${STARTUP_FAILURE_DIAGNOSTIC_ACTION}]`,
  );
  await expect(triage).toContainText('Startup still needs attention');
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
  ).toContainText('Safe diagnostic copied');
  expect(await page.evaluate(() => window.__app.startupDiagnosticText?.()))
    .toBe(reviewedSummary);
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-cold-start-failure-triage-mobile.png`,
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
    .not.toContainText('Browser paired');
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
  await expect(triage).toContainText('Startup needs attention');
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
  await expect(triage).toContainText('Startup still needs attention');
  await expect(triage).toContainText(
    'This tab reloaded, but startup still did not finish.',
  );
  await expect(triage).toContainText(
    'exact page you opened is still selected',
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
    path: `${ARTIFACTS}/full-app-startup-reload-still-failing-mobile.png`,
    fullPage: true,
  });

  const reviewedSummary = await diagnosticSummary.textContent();
  await diagnostic.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_COPY}]`).click();
  await expect(
    diagnostic.locator(`[${STARTUP_FAILURE_DIAGNOSTIC_STATUS}]`),
  ).toContainText('Safe diagnostic copied');
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
    path: `${ARTIFACTS}/full-app-startup-reload-recovery-mobile.png`,
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
  await expect(receipt).not.toContainText('Startup recovered');

  await page.reload();
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page).toHaveURL(target);
  await page.waitForFunction(
    () => window.__app.activeRoute() === 'connections',
  );
  await expect(receipt).toHaveAttribute('data-state', 'ok');
  await expect(receipt).not.toContainText('Startup recovered');
  expect(pageErrors).toHaveLength(0);
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
  await sessionActions.locator('summary').click();
  const resultsBounds = await page.locator('.chat-history-results').boundingBox();
  const menuBounds = await sessionActions
    .locator('.chat-session-action-menu')
    .boundingBox();
  expect(resultsBounds).not.toBeNull();
  expect(menuBounds).not.toBeNull();
  expect(menuBounds!.y).toBeGreaterThanOrEqual(resultsBounds!.y - 0.5);
  expect(menuBounds!.y + menuBounds!.height)
    .toBeLessThanOrEqual(resultsBounds!.y + resultsBounds!.height + 0.5);
  await sessionActions.locator('summary').click();

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
  await expect(page.locator(`[${CHAT_INPUT}]`)).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL(/#chat\/session\/chat_1$/);
  await expect(page.locator(`[${CHAT_SESSION_ROW}="chat_1"]`))
    .toHaveAttribute('aria-current', 'page');
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
