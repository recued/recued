import { expect, test } from '@playwright/test';
import { HARNESS_ORIGIN } from './harness-origin.js';

export const HARNESS_URL = `${HARNESS_ORIGIN}/full-app-harness.html`;
export const FIXED_NOW = 1_700_000_000_000;
export const CHAT_SETUP = 'data-recued-ai-models-chat-setup';
export const SETTINGS_NAV_ITEM = 'data-recued-settings-nav-item';
export const SHARED_REFERENCE = 'data-recued-reference';
export const SHARED_REFERENCE_ID = 'data-recued-reference-id';
export const SHARED_PROVENANCE = 'data-recued-provenance';
export const SHARED_PROVENANCE_PRIMARY = 'data-recued-provenance-primary';
export const SHARED_PROVENANCE_DETAIL = 'data-recued-provenance-detail';
export const DATA_DETAIL_HEADING = 'data-recued-collection-detail-heading';
export const LIST_PREVIEW = 'data-recued-list-preview';
export const SHELL_CONTENT = 'data-recued-webclient-content';
export const LIVE_CONTROL_TOGGLE = 'data-recued-live-control-toggle';
export const LIVE_CONTROL_RUN_CONTROL = 'data-recued-live-control-run-control';
export const CHAT_ACTIVATION = 'data-recued-chat-route-activation';
export const CHAT_INPUT = 'data-recued-chat-route-input';
export const CHAT_SEND = 'data-recued-chat-route-send';
export const CHAT_MESSAGE = 'data-recued-chat-route-message';
export const CHAT_SESSION_ROW = 'data-recued-chat-route-session-row';
export const CHAT_SOURCE_HANDOFF = 'data-recued-chat-source-handoff';
export const CHAT_ANSWER_WAITING = 'data-recued-chat-answer-waiting';
export const CONNECTIONS_ROUTE = 'data-recued-connections-route';
export const DRAWER_TOGGLE = 'data-recued-webclient-drawer-toggle';
export const DRAWER_LINK = 'data-recued-webclient-drawer-link';
export const CHAT_ACTIVATION_ACTION = 'data-recued-chat-route-activation-action';
export const CHAT_COMPOSER_ACTION = 'data-recued-chat-route-composer-action';
export const CHAT_HISTORY_LANDING = 'data-recued-chat-route-history-landing';
export const RUN_PALETTE = 'data-recued-run-palette';
export const SHELL_TOPBAR = 'data-recued-webclient-topbar';
export const DRAWER_ACTION = 'data-recued-webclient-drawer-action';
export const CREATE_OVERLAY = 'data-recued-create-overlay';
export const GLOBAL_RUN_PALETTE_TRIGGER =
  'data-recued-global-run-palette-trigger';
export const SHELL_HOST = 'data-recued-webclient-shell';
export const DRAWER_OPEN = 'data-recued-webclient-drawer-open';
export const ATTENTION_DIALOG = 'data-recued-attention-dialog';
export const ATTENTION_CLOSE = 'data-recued-attention-close-button';
export const ACCOUNT_MENU_TRIGGER = 'data-recued-account-menu-trigger';
export const CONNECTION_BANNER = 'data-recued-connection-banner';

/** Register the full-app boot and uncaught-page-error gates for the calling spec. */
export const installFullAppHooks = (): void => {
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
};
