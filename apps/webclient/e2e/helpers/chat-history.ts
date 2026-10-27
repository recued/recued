import { expect, type Page } from '@playwright/test';

/** Desktop keeps its rail visible; phones open it as a separate pane. */
export const openChatHistory = async (page: Page): Promise<void> => {
  const history = page.locator('[data-recued-chat-route-session-list]');
  await expect(history).toBeAttached();
  if (!await history.isVisible()) {
    await page.locator('[data-recued-chat-route-history-toggle]').click();
  }
  await expect(history).toBeVisible();
};

export const openChatHistoryFilters = async (page: Page): Promise<void> => {
  await openChatHistory(page);
  const panel = page.locator('.chat-history-filter-panel');
  if (await panel.getAttribute('open') === null) await panel.locator('summary').click();
};
