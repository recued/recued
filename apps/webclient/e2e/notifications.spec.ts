import { expect, test } from '@playwright/test';
import { installFullAppHooks } from './helpers/full-app.js';

/** Notification browser journeys against the deterministic full-app harness. */
const NOTIFY_TOAST = 'data-recued-notify-toast';
const NOTIFY_TOAST_DISMISS = 'data-recued-notify-toast-dismiss';

installFullAppHooks();

test('notification dismiss actions stay full-sized and contained', async ({ page }) => {
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'notification.notify',
      title: 'Background_workspace_synchronization_that_must_wrap_on_a_phone',
      text: 'Finished synchronizing the connected workspace.',
      cursor: 1,
    },
  }));

  const toast = page.locator(`[${NOTIFY_TOAST}="toast-1"]`);
  const dismiss = page.locator(`[${NOTIFY_TOAST_DISMISS}="toast-1"]`);
  await expect(toast).toBeVisible();
  const desktopTarget = await dismiss.boundingBox();
  expect(desktopTarget?.width).toBeGreaterThanOrEqual(36);
  expect(desktopTarget?.height).toBeGreaterThanOrEqual(36);

  await page.setViewportSize({ width: 280, height: 653 });
  const mobileGeometry = await toast.evaluate((card) => {
    const toastRect = card.getBoundingClientRect();
    const button = card.querySelector<HTMLButtonElement>('button');
    const buttonRect = button?.getBoundingClientRect();
    return {
      toastLeft: toastRect.left,
      toastRight: toastRect.right,
      buttonWidth: buttonRect?.width ?? 0,
      buttonHeight: buttonRect?.height ?? 0,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(mobileGeometry.toastLeft).toBeGreaterThanOrEqual(-0.5);
  expect(mobileGeometry.toastRight).toBeLessThanOrEqual(
    mobileGeometry.viewportWidth + 0.5,
  );
  expect(await toast.evaluate((card) => card.scrollWidth))
    .toBeLessThanOrEqual(await toast.evaluate((card) => card.clientWidth));
  expect(mobileGeometry.buttonWidth).toBeGreaterThanOrEqual(44);
  expect(mobileGeometry.buttonHeight).toBeGreaterThanOrEqual(44);
  expect(mobileGeometry.documentWidth).toBeLessThanOrEqual(
    mobileGeometry.viewportWidth,
  );

  await dismiss.focus();
  await expect(dismiss).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toast).toHaveCount(0);
});

test('a new notification preserves the focused existing toast action', async ({ page }) => {
  const notify = (text: string, cursor: number) => page.evaluate(
    ({ text: body, cursor: eventCursor }) => window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'notification.notify',
        title: 'Background work',
        text: body,
        cursor: eventCursor,
      },
    }),
    { text, cursor },
  );

  await notify('First finished', 1);
  const firstDismiss = page.locator(`[${NOTIFY_TOAST_DISMISS}="toast-1"]`);
  await firstDismiss.focus();
  await expect(firstDismiss).toBeFocused();

  await notify('Second finished', 2);

  await expect(page.locator(`[${NOTIFY_TOAST}]`)).toHaveCount(2);
  await expect(firstDismiss).toHaveAccessibleName(
    'Dismiss notification: Background work — First finished',
  );
  await expect(page.locator(`[${NOTIFY_TOAST_DISMISS}="toast-2"]`))
    .toHaveAccessibleName(
      'Dismiss notification: Background work — Second finished',
    );
  await expect(firstDismiss).toBeFocused();
});

test('dismissing a notification advances focus through the toast stack', async ({ page }) => {
  for (let cursor = 1; cursor <= 2; cursor += 1) {
    await page.evaluate((eventCursor) => window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'notification.notify',
        title: 'Background work',
        text: `Finished item ${eventCursor}`,
        cursor: eventCursor,
      },
    }), cursor);
  }

  const newest = page.locator(`[${NOTIFY_TOAST_DISMISS}="toast-2"]`);
  const successor = page.locator(`[${NOTIFY_TOAST_DISMISS}="toast-1"]`);
  await newest.focus();
  await page.keyboard.press('Enter');

  await expect(page.locator(`[${NOTIFY_TOAST}="toast-2"]`)).toHaveCount(0);
  await expect(successor).toBeVisible();
  await expect(successor).toBeFocused();
});

test('a focused notification does not auto-dismiss its action', async ({ page }) => {
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'notification.notify',
      title: 'Background work',
      text: 'Focused notice',
      cursor: 1,
    },
  }));
  const dismiss = page.locator(`[${NOTIFY_TOAST_DISMISS}="toast-1"]`);
  await dismiss.focus();

  await page.waitForTimeout(6_250);

  await expect(page.locator(`[${NOTIFY_TOAST}="toast-1"]`)).toBeVisible();
  await expect(dismiss).toBeFocused();
});

test('a notification burst preserves the focused toast within its cap', async ({ page }) => {
  for (let cursor = 1; cursor <= 4; cursor += 1) {
    await page.evaluate((eventCursor) => window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'notification.notify',
        title: 'Burst',
        text: `Notice ${eventCursor}`,
        cursor: eventCursor,
      },
    }), cursor);
  }
  const oldestDismiss = page.locator(
    `[${NOTIFY_TOAST_DISMISS}="toast-1"]`,
  );
  await oldestDismiss.focus();

  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'notification.notify',
      title: 'Burst',
      text: 'Notice 5',
      cursor: 5,
    },
  }));

  await expect(page.locator(`[${NOTIFY_TOAST}]`)).toHaveCount(4);
  await expect(page.locator(`[${NOTIFY_TOAST}="toast-2"]`)).toHaveCount(0);
  await expect(oldestDismiss).toBeFocused();
});
