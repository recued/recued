import { expect, test } from '@playwright/test';
import {
  ACCOUNT_MENU_TRIGGER, ARTIFACTS, ATTENTION_CLOSE, ATTENTION_DIALOG,
  GLOBAL_RUN_PALETTE_TRIGGER, HARNESS_URL, installFullAppHooks,
} from './helpers/full-app.js';

/** Attention browser journeys against the deterministic full-app harness. */
const ATTENTION_TOPBAR = 'data-recued-attention-topbar';
const ATTENTION_ERROR = 'data-recued-attention-error';

installFullAppHooks();

test('the Attention bell is a focused, responsive queue with an exact handoff', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?attention=pending`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const host = page.locator(`[${ATTENTION_TOPBAR}]`);
  const bell = page.getByRole('button', {
    name: '2 items need your attention',
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
  await expect(dialog.getByRole('heading', {
    name: 'Attention',
    level: 2,
  })).toBeVisible();
  await expect(dialog.getByRole('heading', {
    name: 'Send the customer follow-up?',
    level: 3,
  })).toBeVisible();
  await expect(dialog.getByRole('heading', {
    name: "Update Acme's account owner in HubSpot",
    level: 3,
  })).toBeVisible();
  await expect(dialog).toContainText('2 items are waiting for you.');
  // An ask is tagged with how long it has waited (2026-10-07).
  await expect(dialog).toContainText(/(Waiting \S+|Raised just now) · Answer to continue/);
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
    dialog.getByRole('link', { name: 'Open approvals' }),
  ).toBeVisible();
  await expect(page.locator(`[${ATTENTION_CLOSE}]`)).toBeFocused();
  const targetSizes = await dialog.locator('button, a[href]').evaluateAll(
    (targets) => targets.map((target) => {
      const rect = target.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  expect(Math.min(...targetSizes.map(({ width }) => width)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.min(...targetSizes.map(({ height }) => height)))
    .toBeGreaterThanOrEqual(36);

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
  await expect(dialog).toBeVisible();
  await bell.click();
  await expect(dialog).toHaveCount(0);

  await bell.click();
  await dialog.getByRole('link', { name: 'Open approvals' }).click();
  await expect(page).toHaveURL(/#approvals$/);
  await expect(page.locator('[data-recued-approvals-route]')).toBeVisible();
  await expect(page.locator(`[${ATTENTION_DIALOG}]`)).toHaveCount(0);
});

test('the Attention popover closes when keyboard focus leaves it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?attention=pending`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const bell = page.getByRole('button', {
    name: '2 items need your attention',
  });
  await bell.click();

  const dialog = page.locator(`[${ATTENTION_DIALOG}]`);
  const handoff = dialog.getByRole('link', { name: 'Open approvals' });
  await handoff.focus();
  await page.keyboard.press('Tab');

  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`[${GLOBAL_RUN_PALETTE_TRIGGER}]`)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator(`[${ACCOUNT_MENU_TRIGGER}]`)).toBeFocused();
});

test('Attention inline decisions retain exact pending ownership', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=pending&attention_action_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  await page.getByRole('button', {
    name: '2 items need your attention',
  }).click();
  const dialog = page.locator(`[${ATTENTION_DIALOG}]`);
  const approve = dialog.getByRole('button', {
    name: "Approve: Update Acme's account owner in HubSpot",
  });
  await approve.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('approval.resolve'))).toBe(1);

  expect(await approve.evaluate((button) => ({
    disabled: button.hasAttribute('disabled'),
    ariaDisabled: button.getAttribute('aria-disabled'),
    ariaBusy: button.getAttribute('aria-busy'),
    focused: button === document.activeElement,
  }))).toEqual({
    disabled: false,
    ariaDisabled: 'true',
    ariaBusy: 'true',
    focused: true,
  });
  await approve.dispatchEvent('click');
  await approve.dispatchEvent('click');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('approval.resolve'))).toBe(1);

  await expect(approve).toHaveCount(0);
  const answer = dialog.getByRole('button', {
    name: 'Approve: Send the customer follow-up?',
  });
  await answer.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('notification.submitAnswer'))).toBe(1);
  expect(await answer.evaluate((button) => ({
    disabled: button.hasAttribute('disabled'),
    ariaDisabled: button.getAttribute('aria-disabled'),
    ariaBusy: button.getAttribute('aria-busy'),
    focused: button === document.activeElement,
  }))).toEqual({
    disabled: false,
    ariaDisabled: 'true',
    ariaBusy: 'true',
    focused: true,
  });
  await answer.dispatchEvent('click');
  await answer.dispatchEvent('click');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('notification.submitAnswer'))).toBe(1);
});

test('Attention protects an unresolved decision from tab unload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=pending&attention_action_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.getByRole('button', {
    name: '2 items need your attention',
  }).click();

  const approve = page.locator(`[${ATTENTION_DIALOG}]`).getByRole('button', {
    name: "Approve: Update Acme's account owner in HubSpot",
  });
  await approve.click();
  await expect(approve).toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return window.dispatchEvent(event);
  })).toBe(false);

  await expect(approve).toHaveCount(0);
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return window.dispatchEvent(event);
  })).toBe(true);
});

test('Attention returns a failed inline approval to its exact action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=pending&attention_action_response=slow`
    + '&approval_resolve_response=fail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${ATTENTION_TOPBAR}] .top-bar-attention-bell`).click();

  const dialog = page.locator(`[${ATTENTION_DIALOG}]`);
  const reject = dialog.getByRole('button', {
    name: "Reject: Update Acme's account owner in HubSpot",
  });
  await reject.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('approval.resolve'))).toBe(1);
  await expect(reject).toHaveAttribute('aria-disabled', 'true');
  await expect(reject).toHaveAttribute('aria-busy', 'true');
  await expect(reject).toBeFocused();

  await expect(dialog.locator(`[${ATTENTION_ERROR}]`)).toContainText(
    "Couldn't update approval: The approval decision could not be saved.",
  );
  await expect(reject).not.toHaveAttribute('aria-disabled');
  await expect(reject).not.toHaveAttribute('aria-busy');
  await expect(reject).toBeFocused();
});

test('Attention Chat-plan decisions retain exact pending ownership', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=plan&attention_action_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${ATTENTION_TOPBAR}] .top-bar-attention-bell`).click();

  const dialog = page.locator(`[${ATTENTION_DIALOG}]`);
  const approve = dialog.getByRole('button', {
    name: 'Approve: Mail send',
  });
  await approve.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('chat.plan.approve'))).toBe(1);
  expect(await approve.evaluate((button) => ({
    disabled: button.hasAttribute('disabled'),
    ariaDisabled: button.getAttribute('aria-disabled'),
    ariaBusy: button.getAttribute('aria-busy'),
    focused: button === document.activeElement,
  }))).toEqual({
    disabled: false,
    ariaDisabled: 'true',
    ariaBusy: 'true',
    focused: true,
  });
  await approve.dispatchEvent('click');
  await approve.dispatchEvent('click');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('chat.plan.approve'))).toBe(1);
});

test('Attention keeps destructive confirmation armed while resolving', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=destructive&attention_action_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${ATTENTION_TOPBAR}] .top-bar-attention-bell`).click();

  const dialog = page.locator(`[${ATTENTION_DIALOG}]`);
  await dialog.getByRole('button', {
    name: "Approve: Update Acme's account owner in HubSpot",
  }).click();
  const confirm = dialog.getByRole('button', {
    name: "Confirm: Update Acme's account owner in HubSpot",
  });
  const cancel = dialog.getByRole('button', {
    name: "Cancel confirmation: Update Acme's account owner in HubSpot",
  });
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('approval.resolve'))).toBe(1);
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).toBeFocused();
  await cancel.dispatchEvent('click');
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeFocused();
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('approval.resolve'))).toBe(1);
});
