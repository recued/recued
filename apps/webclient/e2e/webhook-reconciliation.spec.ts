import { expect, test } from '@playwright/test';
import { installFullAppHooks } from './helpers/full-app.js';
import {
  DISABLE_WEBHOOK, DISMISS_STRAYS, LIST_WEBHOOKS, RECOVERY_INGRESS, RECONCILE_WEBHOOK, RETIRE_WEBHOOK,
  SET_WEBHOOK_DOOR, mixedStrays, openWebhookRecovery, recipeRecoveryRow, recoveryRow, webhookAction, webhookCard, webhookWrites,
} from './helpers/webhook-reconciliation-fixture.js';

installFullAppHooks();
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 390, height: 850 }); });

test('Webhook recovery distinguishes changed endpoints from owned cleanup without writing on inspection', async ({ page }) => {
  await openWebhookRecovery(page, { row: recoveryRow({ stray_endpoints: 2, stray_endpoints_given_up: 2, strays: mixedStrays() }) });
  const notice = webhookCard(page).locator('[data-recued-webhooks-strays]');
  await expect(notice).toContainText('we_proven_stopped_retrying');
  await expect(notice).toContainText('we_changed_stopped_looking');
  await expect(notice).toContainText('we_proven_still_retrying');
  await expect(notice).toContainText('we_changed_still_looking');
  await expect(notice).toContainText('it does not remove it');
  await expect(webhookAction(page, 'strays-dismiss')).toBeVisible();
  await webhookCard(page).getByText('Configuration and delivery rules', { exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search webhooks' }).fill('billing');
  expect(await webhookWrites(page)).toEqual([]);
});

for (const scenario of [
  { name: 'disabled endpoint', row: recoveryRow(), method: DISABLE_WEBHOOK, args: { ingress_id: RECOVERY_INGRESS } },
  { name: 'unfinished account swap', row: recoveryRow({ pending_paired_connection_id: 'billing-replacement' }), method: RECONCILE_WEBHOOK,
    args: { ingress_id: RECOVERY_INGRESS, paired_connection_id: 'billing-replacement' } },
  { name: 'retired endpoint', row: recoveryRow({ intake_state: 'retired' }), method: RETIRE_WEBHOOK, args: { ingress_id: RECOVERY_INGRESS } },
]) test(`Webhook cleanup retries the ${scenario.name} once and keeps its exact target after failure`, async ({ page }) => {
  await openWebhookRecovery(page, { row: scenario.row, held: [scenario.method] });
  const retry = webhookAction(page, 'cleanup-retry');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(method => window.__webhookRecovery.pending(method), scenario.method)).toBe(1);
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(await webhookWrites(page)).toEqual([{ method: scenario.method, args: scenario.args }]);
  await page.evaluate(method => window.__webhookRecovery.release(method, true), scenario.method);
  await expect(page.locator('[data-recued-webhooks-error]')).toContainText('temporarily unavailable');
  await expect(retry).toBeFocused();
  await expect(retry).not.toHaveAttribute('aria-busy', 'true');
  await page.evaluate(method => { window.__webhookRecovery.held = window.__webhookRecovery.held.filter(value => value !== method); }, scenario.method);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await webhookWrites(page)).length).toBe(2);
  expect(await webhookWrites(page)).toEqual(Array.from({ length: 2 }, () => ({ method: scenario.method, args: scenario.args })));
  await expect(page.locator('[data-recued-webhooks-error]')).toHaveCount(0);
  await expect(retry).toBeFocused();
});

for (const terminal of [false, true]) test(`Webhook ${terminal ? 'dismissal' : 'cleanup'} does not steal focus when its delayed response settles`, async ({ page }) => {
  const method = terminal ? DISMISS_STRAYS : DISABLE_WEBHOOK;
  await openWebhookRecovery(page, { held: [method], ...(terminal ? { row: recoveryRow({ intake_state: 'retired', registration_state: 'retired',
    remote_endpoint_id: null, stray_endpoints_given_up: 2, strays: mixedStrays().filter(row => row.given_up) }) } : {}) });
  await webhookAction(page, terminal ? 'strays-dismiss' : 'cleanup-retry').click();
  await expect.poll(() => page.evaluate(method => window.__webhookRecovery.pending(method), method)).toBe(1);
  const account = page.locator('[data-recued-account-menu-trigger]');
  await account.focus();
  await page.evaluate(({ method, terminal }) => window.__webhookRecovery.release(method, !terminal), { method, terminal });
  if (terminal) await expect(webhookCard(page)).toHaveCount(0);
  else await expect(page.locator('[data-recued-webhooks-error]')).toContainText('temporarily unavailable');
  await expect(account).toBeFocused();
});

test('Webhook controls detached by filtering cannot retry cleanup or dismiss endpoint records', async ({ page }) => {
  await openWebhookRecovery(page, { row: recoveryRow({ intake_state: 'retired', stray_endpoints_given_up: 2, strays: mixedStrays().filter(row => row.given_up) }) });
  const retry = await webhookAction(page, 'cleanup-retry').elementHandle();
  const dismiss = await webhookAction(page, 'strays-dismiss').elementHandle();
  await page.getByRole('searchbox', { name: 'Search webhooks' }).fill('no matching webhook');
  await expect(webhookCard(page)).toHaveCount(0);
  await retry!.evaluate(node => (node as HTMLButtonElement).click());
  await dismiss!.evaluate(node => (node as HTMLButtonElement).click());
  await page.getByRole('searchbox', { name: 'Search webhooks' }).fill('');
  expect(await webhookWrites(page)).toEqual([]);
  await expect(webhookAction(page, 'cleanup-retry')).toBeVisible();
  await expect(webhookAction(page, 'strays-dismiss')).toBeVisible();
});

test('Webhook retired endpoint records dismiss once and leave durable panel focus', async ({ page }) => {
  await openWebhookRecovery(page, { row: recoveryRow({ intake_state: 'retired', registration_state: 'retired', remote_endpoint_id: null,
    stray_endpoints_given_up: 2, strays: mixedStrays().filter(row => row.given_up) }), held: [DISMISS_STRAYS] });
  await expect(webhookAction(page, 'cleanup-retry')).toHaveCount(0);
  await expect(webhookAction(page, 'enable')).toHaveCount(0);
  await webhookAction(page, 'strays-dismiss').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(method => window.__webhookRecovery.pending(method), DISMISS_STRAYS)).toBe(1);
  await page.keyboard.press('Space');
  expect(await webhookWrites(page)).toEqual([{ method: DISMISS_STRAYS, args: { ingress_id: RECOVERY_INGRESS } }]);
  await page.evaluate(method => window.__webhookRecovery.release(method), DISMISS_STRAYS);
  await expect(webhookCard(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Webhooks coming in', exact: true })).toBeFocused();
  await expect(page.getByText('No webhooks coming in yet.', { exact: true })).toBeVisible();
});

test('Webhook failed relist drops configuration authority but retains safe cleanup recovery', async ({ page }) => {
  await openWebhookRecovery(page, { held: [DISABLE_WEBHOOK] });
  await webhookAction(page, 'cleanup-retry').click();
  await expect.poll(() => page.evaluate(method => window.__webhookRecovery.pending(method), DISABLE_WEBHOOK)).toBe(1);
  await page.evaluate(({ list, disable }) => { window.__webhookRecovery.failing.push(list); window.__webhookRecovery.release(disable); }, { list: LIST_WEBHOOKS, disable: DISABLE_WEBHOOK });
  await expect(page.getByRole('button', { name: 'Refresh webhooks', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New webhook', exact: true })).toBeDisabled();
  await expect(webhookAction(page, 'connection-rebind')).toHaveCount(0);
  await expect(webhookAction(page, 'cleanup-retry')).toBeEnabled();
  await page.evaluate(() => { window.__webhookRecovery.failing = []; });
  await page.getByRole('button', { name: 'Refresh webhooks', exact: true }).click();
  await expect(page.locator('[data-recued-webhooks-error]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New webhook', exact: true })).toBeEnabled();
  expect(await webhookWrites(page)).toHaveLength(1);
});

test('Webhook pending cleanup guards route departure and ignores a response after accepted departure', async ({ page }) => {
  await openWebhookRecovery(page, { held: [DISABLE_WEBHOOK] });
  await webhookAction(page, 'cleanup-retry').click();
  await expect.poll(() => page.evaluate(method => window.__webhookRecovery.pending(method), DISABLE_WEBHOOK)).toBe(1);
  const decline = page.waitForEvent('dialog').then(async dialog => { expect(dialog.message()).toContain('still doing something'); await dialog.dismiss(); });
  await page.evaluate(() => window.__app.setHash('#settings'));
  await decline;
  await expect(webhookCard(page)).toBeVisible();
  const accept = page.waitForEvent('dialog').then(dialog => dialog.accept());
  await page.evaluate(() => window.__app.setHash('#settings'));
  await accept;
  await expect(webhookCard(page)).toHaveCount(0);
  const reads = await page.evaluate(method => window.__webhookRecovery.calls.filter(call => call.method === method).length, LIST_WEBHOOKS);
  await page.evaluate(method => window.__webhookRecovery.release(method), DISABLE_WEBHOOK);
  await expect.poll(() => page.evaluate(method => window.__webhookRecovery.pending(method), DISABLE_WEBHOOK)).toBe(0);
  // A subsequent local read gives the old completion a chance to run without
  // sleeping; it must neither remount the page nor issue a disposed relist.
  await page.getByRole('searchbox', { name: 'Find a setting', exact: true }).fill('privacy');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  expect(await page.evaluate(method => window.__webhookRecovery.calls.filter(call => call.method === method).length, LIST_WEBHOOKS)).toBe(reads);
  await expect(webhookCard(page)).toHaveCount(0);
});

for (const opening of [true, false]) test(`Webhook recipe ${opening ? 'opening' : 'closing'} keeps the selected recipe through pending, retry and replacement`, async ({ page }) => {
  await openWebhookRecovery(page, { row: recipeRecoveryRow(!opening), held: [SET_WEBHOOK_DOOR] });
  const recipe = webhookCard(page).locator('[data-recued-webhooks-recipe="billing-alerts"]');
  const action = recipe.locator(`[data-recued-webhooks-action="door-${opening ? 'open' : 'close'}"]`);
  await action.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(method => window.__webhookRecovery.pending(method), SET_WEBHOOK_DOOR)).toBe(1);
  await expect(action).toBeFocused();
  await expect(action).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Space');
  const expected = { method: SET_WEBHOOK_DOOR, args: { ingress_id: RECOVERY_INGRESS, recipe_id: 'billing-alerts', open: opening } };
  expect(await webhookWrites(page)).toEqual([expected]);
  await page.evaluate(method => window.__webhookRecovery.release(method, true), SET_WEBHOOK_DOOR);
  await expect(page.locator('[data-recued-webhooks-error]')).toContainText('temporarily unavailable');
  await expect(action).toBeFocused();
  const stale = await action.elementHandle();
  await page.getByRole('searchbox', { name: 'Search webhooks' }).fill('no matching webhook');
  await stale!.evaluate(node => (node as HTMLButtonElement).click());
  await page.getByRole('searchbox', { name: 'Search webhooks' }).fill('');
  expect(await webhookWrites(page)).toEqual([expected]);
  await page.evaluate(() => { window.__webhookRecovery.held = []; });
  await action.focus();
  await page.keyboard.press('Enter');
  const successor = recipe.locator(`[data-recued-webhooks-action="door-${opening ? 'close' : 'open'}"]`);
  await expect(successor).toBeFocused();
  expect(await webhookWrites(page)).toEqual([expected, expected]);
});

test('Webhook recipe removed during a door action leaves focus on the webhook rather than a different recipe', async ({ page }) => {
  await openWebhookRecovery(page, { row: recipeRecoveryRow(false), held: [SET_WEBHOOK_DOOR] });
  const recipe = webhookCard(page).locator('[data-recued-webhooks-recipe="billing-alerts"]');
  await recipe.locator('[data-recued-webhooks-action="door-open"]').click();
  await expect.poll(() => page.evaluate(method => window.__webhookRecovery.pending(method), SET_WEBHOOK_DOOR)).toBe(1);
  await page.evaluate(method => {
    const fixture = window.__webhookRecovery;
    fixture.rows = fixture.rows.map(row => ({ ...row, recipes: (row.recipes ?? []).filter(recipe => recipe.recipe_id !== 'billing-alerts') }));
    fixture.release(method, true);
  }, SET_WEBHOOK_DOOR);
  await expect(recipe).toHaveCount(0);
  await expect(webhookCard(page).getByRole('heading', { level: 3 })).toBeFocused();
  expect(await webhookWrites(page)).toEqual([{ method: SET_WEBHOOK_DOOR,
    args: { ingress_id: RECOVERY_INGRESS, recipe_id: 'billing-alerts', open: true } }]);
});
