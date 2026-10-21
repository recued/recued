import { expect, test } from '@playwright/test';
import {
  ARTIFACTS, CHAT_ACTIVATION, CHAT_ANSWER_WAITING, CHAT_INPUT, CHAT_MESSAGE,
  CHAT_SEND, CHAT_SESSION_ROW, CHAT_SOURCE_HANDOFF, CONNECTIONS_ROUTE,
  HARNESS_URL, SHARED_REFERENCE, SHARED_REFERENCE_ID, installFullAppHooks,
} from './helpers/full-app.js';

/** Connections browser journeys against the deterministic full-app harness. */
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
const SHARED_REFERENCE_DISCLOSURE = 'data-recued-reference-disclosure';
const SHARED_REFERENCE_ITEM = 'data-recued-reference-item';
const CHAT_RETURN_TARGET = 'data-recued-chat-route-return-target';
const CHAT_FOLLOWUP_CONTEXT = 'data-recued-chat-followup-context';
const CHAT_FOLLOWUP_CONTEXT_CLEAR =
  'data-recued-chat-followup-context-clear';
const CONNECTIONS_DESCRIPTION = 'data-recued-connections-route-description';
const CONNECTIONS_TABS = 'data-recued-connections-route-tabs';
const CONNECTIONS_GRANTS = 'data-recued-connections-route-grants';
const CONNECTIONS_GRANT_TOGGLE = 'data-recued-conn-grant-toggle';
const CONNECTIONS_PACK_INVENTORY = 'data-connections-pack-inventory';
const CONNECTIONS_PACK_INVENTORY_RETRY =
  'data-connections-pack-inventory-retry';
const WEBHOOKS_CARD = 'data-recued-webhooks-card';
const WEBHOOKS_ACTION = 'data-recued-webhooks-action';
const WEBHOOKS_DELIVERY = 'data-recued-webhooks-delivery';
const WEBHOOKS_FIELD = 'data-recued-webhooks-field';
const WEBHOOKS_NEW = 'data-recued-webhooks-new';
const WEBHOOKS_PANEL = 'data-recued-webhooks-panel';
const WEBHOOKS_PAYLOAD = 'data-recued-webhooks-payload';
const WEBHOOKS_TEST_DELIVERY = 'data-recued-webhooks-test-delivery';
const ACCOUNTS_EMPTY = 'data-accounts-empty';
const ACCOUNT_CONNECTION_SUCCESS = 'data-accounts-connection-success';
const OAUTH_APP_STATE = 'data-oauth-app-state';
const OAUTH_CRED_FIELD = 'data-oauth-cred-field';
const DATA_CHAT_RETURN = 'data-recued-data-route-chat-return';

installFullAppHooks();

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
  const providerHeading = page.getByRole('heading', {
    name: 'Choose a mail provider',
    level: 2,
  });
  await expect(providerHeading).toBeVisible();
  await expect(providerHeading).toBeFocused();
  const gmailProvider = route.locator(
    '[data-action="accounts-pick-provider"][data-provider="gmail"]',
  );
  await expect(gmailProvider).toBeVisible();
  await expect(page.getByRole('button', { name: /Microsoft/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /IMAP \/ SMTP/ })).toBeVisible();

  await gmailProvider.click();
  const gmailHeading = route.getByRole('heading', { name: 'Connect Gmail', level: 2 });
  await expect(gmailHeading).toBeVisible();
  await expect(gmailHeading).toBeFocused();

  await route.getByRole('button', { name: 'Back' }).click();
  await expect(gmailProvider).toBeFocused();
  await route.getByRole('button', { name: 'Cancel' }).click();
  await expect(connect).toBeFocused();

  const calendarTab = tabs.getByRole('link', { name: 'Calendar' });
  await calendarTab.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#connections\/calendar$/);
  await expect(calendarTab).toHaveAttribute('aria-current', 'page');
  await expect(calendarTab).toBeFocused();
  await expect(route.locator(`[${ACCOUNTS_EMPTY}]`)).toContainText(
    'Connect your first calendar',
  );
  await expect(
    route.getByRole('button', { name: 'Connect calendar' }),
  ).toBeVisible();

  const filesTab = route.getByRole('link', { name: 'Files' });
  await filesTab.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#connections\/file$/);
  await expect(filesTab).toHaveAttribute('aria-current', 'page');
  await expect(filesTab).toBeFocused();
  await expect(route.locator(`[${ACCOUNTS_EMPTY}]`)).toContainText(
    'Add your first file source',
  );
  await expect(
    route.getByRole('button', { name: 'Add file source' }),
  ).toBeVisible();

  // A direct mobile deep link to the trailing lane must reveal its active tab;
  // the horizontal strip otherwise starts at Mail and clips Webhooks entirely.
  await page.evaluate(() => window.__app.setHash('#connections/webhooks'));
  await expect(page).toHaveURL(/#connections\/webhooks$/);
  const webhooksTab = route.getByRole('link', { name: 'Webhooks' });
  await expect(webhooksTab).toHaveAttribute('aria-current', 'page');
  const tabVisibility = await tabs.evaluate((tabBar) => {
    const active = tabBar.querySelector('[aria-current="page"]');
    const barRect = tabBar.getBoundingClientRect();
    const activeRect = active?.getBoundingClientRect();
    return {
      scrollLeft: tabBar.scrollLeft,
      barLeft: barRect.left,
      barRight: barRect.right,
      activeLeft: activeRect?.left ?? Number.NEGATIVE_INFINITY,
      activeRight: activeRect?.right ?? Number.POSITIVE_INFINITY,
    };
  });
  expect(tabVisibility.scrollLeft).toBeGreaterThan(0);
  expect(tabVisibility.activeLeft).toBeGreaterThanOrEqual(
    tabVisibility.barLeft - 0.5,
  );
  expect(tabVisibility.activeRight).toBeLessThanOrEqual(
    tabVisibility.barRight + 0.5,
  );
});

test('a Connections account detail returns focus to its exact row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?connection=source-ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#connections'));

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  const account = route.locator(
    '[data-action="accounts-open-detail"][data-slug="work"]',
  );
  await expect(account).toBeVisible();
  await expect(route.getByRole('heading', { name: 'Mailboxes', level: 2 }))
    .toBeVisible();
  await expect(route.locator('.accounts-blurb')).toHaveText(
    'Recued can search these mailboxes and use them in your work. '
      + 'Sending is up to you.',
  );
  await account.focus();
  await page.keyboard.press('Enter');

  const heading = route.getByRole('heading', { name: 'work', level: 2 });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();

  await route.getByRole('button', { name: 'Back' }).focus();
  await page.keyboard.press('Enter');
  await expect(account).toBeFocused();
});

test('Connections contains long account identities through removal review', async ({ page }) => {
  const longSlug = `mailbox-${'identity'.repeat(7)}`;
  const longEmail = `${'account'.repeat(8)}@example.test`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?connection=source-ready&account_text=long#connections`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  const account = route.locator('[data-action="accounts-open-detail"]').first();
  await expect(account.locator('.accounts-row-name')).toHaveText(longSlug);
  await expect(account.locator('.accounts-row-sub')).toHaveText(longEmail);
  const listGeometry = await route.locator('.accounts-panel').evaluate((panel) => {
    const routeHost = panel.closest<HTMLElement>('[data-recued-connections-route]');
    const elements = [
      panel,
      panel.querySelector<HTMLElement>('.accounts-rows'),
      panel.querySelector<HTMLElement>('.accounts-row'),
      panel.querySelector<HTMLElement>('.accounts-row-main'),
      panel.querySelector<HTMLElement>('.accounts-row-name'),
      panel.querySelector<HTMLElement>('.accounts-row-sub'),
    ].filter((element): element is HTMLElement => element !== null);
    return {
      routeScrollWidth: routeHost?.scrollWidth ?? 0,
      routeClientWidth: routeHost?.clientWidth ?? 0,
      elements: elements.map((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      })),
    };
  });
  expect(listGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(listGeometry.routeClientWidth);
  for (const bounds of listGeometry.elements) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }

  await account.click();
  const heading = route.locator('[data-accounts-detail-heading]');
  await expect(heading).toHaveText(longSlug);
  await expect(route.locator('.accounts-detail-grid')).toContainText(longEmail);
  const detailGeometry = await route.locator('.accounts-detail').evaluate((detail) => {
    const routeHost = detail.closest<HTMLElement>('[data-recued-connections-route]');
    const elements = [
      detail,
      detail.querySelector<HTMLElement>('.accounts-detail-title'),
      detail.querySelector<HTMLElement>('.accounts-detail-grid'),
      ...detail.querySelectorAll<HTMLElement>('.accounts-detail-grid dd'),
    ].filter((element): element is HTMLElement => element !== null);
    return {
      routeScrollWidth: routeHost?.scrollWidth ?? 0,
      routeClientWidth: routeHost?.clientWidth ?? 0,
      elements: elements.map((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      })),
    };
  });
  expect(detailGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(detailGeometry.routeClientWidth);
  for (const bounds of detailGeometry.elements) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }

  await route.getByRole('button', { name: 'Remove', exact: true }).click();
  const dialog = page.locator('[data-accounts-delete-dialog]');
  await expect(dialog).toHaveAttribute('aria-label', `Remove account ${longSlug}`);
  await expect(dialog.locator('.accounts-delete-title')).toHaveText(
    `Remove ${longSlug}?`,
  );
  await expect(dialog.locator('.accounts-delete-body')).toContainText('Gmail');
  const dialogGeometry = await dialog.evaluate((surface) => {
    const elements = [
      surface,
      surface.querySelector<HTMLElement>('.accounts-delete-title'),
      surface.querySelector<HTMLElement>('.accounts-delete-body'),
      surface.querySelector<HTMLElement>('.accounts-delete-actions'),
    ].filter((element): element is HTMLElement => element !== null);
    return elements.map((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
  });
  for (const bounds of dialogGeometry) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }
});

test('Connections webhook writes retain their exact action focus and stay single-flight', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?connection=webhooks&webhook_test_response=slow#connections/webhooks`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const card = page.locator(`[${WEBHOOKS_CARD}]`);
  await expect(card).toContainText('Signed test deliveries');
  const actions = card.locator(`[${WEBHOOKS_ACTION}]`);
  await expect(actions).toHaveCount(7);
  const actionHeights = await actions.evaluateAll((targets) => targets.map(
    (target) => target.getBoundingClientRect().height,
  ));
  expect(Math.min(...actionHeights)).toBeGreaterThanOrEqual(36);
  const sendTest = card.locator(`[${WEBHOOKS_ACTION}="test-delivery"]`);
  const callsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('webhook.ingress.test.deliver'),
  );

  await sendTest.focus();
  await page.keyboard.press('Enter');
  await expect(sendTest).toBeFocused();
  await expect(sendTest).toHaveAttribute('aria-disabled', 'true');
  await expect(sendTest).toHaveAttribute('aria-busy', 'true');
  await expect(sendTest).not.toHaveAttribute('disabled');

  await sendTest.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('webhook.ingress.test.deliver'),
    ),
  ).toBe(callsBefore + 1);

  await expect(card.locator(`[${WEBHOOKS_TEST_DELIVERY}]`)).toContainText(
    'arrived and was kept at',
  );
  await expect(sendTest).toBeFocused();
  await expect(sendTest).not.toHaveAttribute('aria-disabled');
  await expect(sendTest).not.toHaveAttribute('aria-busy');
  await expect(sendTest).not.toHaveAttribute('disabled');
});

test('Connections webhook disclosures hand focus to their logical destination', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?connection=webhooks#connections/webhooks`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const card = page.locator(`[${WEBHOOKS_CARD}]`);
  const rotate = card.locator(`[${WEBHOOKS_ACTION}="credentials"]`);
  await rotate.click();
  await expect(card.locator(`[${WEBHOOKS_FIELD}]`).first()).toBeFocused();
  await card.locator(`[${WEBHOOKS_ACTION}="credential-cancel"]`).click();
  await expect(rotate).toBeFocused();

  const newWebhook = page.locator(`[${WEBHOOKS_NEW}]`);
  await newWebhook.click();
  await expect(page.locator(`[${WEBHOOKS_FIELD}="display_name"]`)).toBeFocused();
  await page.locator(`[${WEBHOOKS_ACTION}="create-cancel"]`).click();
  await expect(newWebhook).toBeFocused();

  const deliveries = card.locator(`[${WEBHOOKS_ACTION}="deliveries"]`);
  await deliveries.click();
  await expect(deliveries).toHaveText('Hide the messages that got through');
  await expect(deliveries).toBeFocused();

  const deliveriesList = card.locator(`[${WEBHOOKS_DELIVERY}]`);
  await expect(deliveriesList).toHaveCount(2);
  const delivery = deliveriesList.nth(1);
  const inspect = delivery.locator(`[${WEBHOOKS_ACTION}="delivery-open"]`);
  await inspect.click();
  const back = card.locator(`[${WEBHOOKS_ACTION}="deliveries-back"]`);
  await expect(back).toBeFocused();

  await card.locator(`[${WEBHOOKS_ACTION}="event-open"]`).click();
  const payload = card.locator(`[${WEBHOOKS_PAYLOAD}]`);
  await expect(payload).toContainText('accepted');
  await expect(payload).toBeFocused();

  await back.click();
  await expect(inspect).toBeFocused();
});

test('Connections webhook terminal writes hand focus to durable context', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?connection=webhooks&webhook_terminal_response=slow#connections/webhooks`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const panel = page.locator(`[${WEBHOOKS_PANEL}]`);
  const newWebhook = page.locator(`[${WEBHOOKS_NEW}]`);
  await newWebhook.click();
  await page.locator(`[${WEBHOOKS_FIELD}="display_name"]`).fill('Browser-created webhook');
  await page.locator(`[${WEBHOOKS_FIELD}="signature_header"]`).fill('X-Signature');
  await page.locator(`[${WEBHOOKS_FIELD}="signing_secret"]`).fill('browser-secret');
  const create = page.locator(`[${WEBHOOKS_ACTION}="create-submit"]`);
  await create.focus();
  await page.keyboard.press('Enter');
  await expect(create).toBeFocused();
  await expect(create).toHaveAttribute('aria-disabled', 'true');
  await expect(create).toHaveAttribute('aria-busy', 'true');

  const createdCard = page.locator(`[${WEBHOOKS_CARD}]`, {
    hasText: 'Browser-created webhook',
  });
  await expect(createdCard.locator('h3')).toBeFocused();
  await expect(createdCard).toContainText('manual pending · draft');

  const originalCard = page.locator(`[${WEBHOOKS_CARD}]`, {
    hasText: 'Signed test deliveries',
  });
  await expect(originalCard.locator(`[${WEBHOOKS_ACTION}="credentials"]`))
    .toHaveAccessibleName(
      /^Swap the keys for Signed test deliveries \(whi_/,
    );
  await expect(createdCard.locator(`[${WEBHOOKS_ACTION}="credentials"]`))
    .toHaveAccessibleName(
      /^Swap the keys for Browser-created webhook \(whi_/,
    );
  await expect(originalCard.locator(`[${WEBHOOKS_ACTION}="deliveries"]`))
    .toHaveAccessibleName(
      /^See the messages that got through for Signed test deliveries \(whi_/,
    );
  await expect(createdCard.locator(`[${WEBHOOKS_ACTION}="deliveries"]`))
    .toHaveAccessibleName(
      /^See the messages that got through for Browser-created webhook \(whi_/,
    );
  await originalCard.locator(`[${WEBHOOKS_ACTION}="disable"]`).click();
  await expect(originalCard.locator(`[${WEBHOOKS_ACTION}="enable"]`)).toBeFocused();
  await originalCard.locator(`[${WEBHOOKS_ACTION}="retire"]`).click();
  const confirmRetire = originalCard.locator(
    `[${WEBHOOKS_ACTION}="retire-confirm"]`,
  );
  await expect(confirmRetire).toBeFocused();
  await confirmRetire.click();
  await expect(confirmRetire).toBeFocused();
  await expect(confirmRetire).toHaveAttribute('aria-disabled', 'true');
  await expect(confirmRetire).toHaveAttribute('aria-busy', 'true');

  await expect(originalCard).toHaveCount(0);
  await expect(panel.locator('h2')).toBeFocused();
  await expect(createdCard).toBeVisible();
});

test('Connections account lifecycle writes keep their exact action focused and single-flight', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?connection=calendar-lifecycle#connections/calendar/work-calendar`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  await expect(route.getByRole('heading', {
    name: 'work-calendar',
    level: 2,
  })).toBeVisible();

  const exercise = async (
    readyName: 'Re-sync' | 'Re-authorize',
    busyName: 'Re-syncing…' | 'Re-authorizing…',
    method: 'collection.calendar.resync' | 'collection.calendar.reauth',
  ): Promise<void> => {
    const action = route.getByRole('button', { name: readyName, exact: true });
    await action.focus();
    await page.keyboard.press('Enter');

    const busy = route.getByRole('button', { name: busyName, exact: true });
    await expect(busy).toHaveAttribute('aria-disabled', 'true');
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(busy).not.toHaveAttribute('disabled');
    await expect(busy).toBeFocused();

    await busy.evaluate((element) => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(await page.evaluate((rpcMethod) => (
      window.__app.rpcCallCount(rpcMethod)
    ), method)).toBe(1);

    await expect(action).toBeFocused();
    expect(await page.evaluate((rpcMethod) => (
      window.__app.rpcCallCount(rpcMethod)
    ), method)).toBe(1);
  };

  await exercise(
    'Re-sync',
    'Re-syncing…',
    'collection.calendar.resync',
  );
  const beforeReview = await page.evaluate(() => window.__app.rpcCallCount('collection.connection.managedOAuth'));
  await route.getByRole('button', { name: 'Manage authentication', exact: true }).click();
  await expect(route.getByText('Checking sign-in and account access…', { exact: true })).toBeVisible();
  const reviewChoice = route.locator('[data-action="accounts-authentication-choice"][data-choice="reauthorize"]');
  await expect(reviewChoice).toBeDisabled();
  await reviewChoice.evaluate(element => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(await page.evaluate(() => window.__app.rpcCallCount('collection.connection.managedOAuth'))).toBe(beforeReview + 1);
  await expect(route.getByRole('alert')).toContainText(
    'Calendar sign-in is temporarily unavailable.',
  );
  await expect(route.locator('[data-oauth-app-switch-heading]')).toBeFocused();
});

test('Connections keeps enrolled actions without retired operation grants', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`${HARNESS_URL}?connection=grants`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#connections/others'));

  const grants = page.locator(`[${CONNECTIONS_GRANTS}]`);
  const enrolled = page.getByRole('region', { name: 'Enrolled connections' });
  await expect(enrolled.getByRole('heading', {
    name: 'Enrolled connections',
    level: 2,
  })).toBeAttached();
  await expect(enrolled.getByRole('heading', {
    name: 'API (1)',
    level: 3,
  })).toBeVisible();
  const enrolledRow = enrolled.locator('.connections-row').first();
  const actionBounds = await enrolledRow.locator(
    '.connections-row-actions',
  ).evaluate((actions) => {
    const row = actions.closest('.connections-row')?.getBoundingClientRect();
    const controls = [...actions.querySelectorAll('button')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { right: rect.right, bottom: rect.bottom };
    });
    return {
      rowRight: row?.right ?? Number.NEGATIVE_INFINITY,
      rowBottom: row?.bottom ?? Number.NEGATIVE_INFINITY,
      controls,
    };
  });
  expect(actionBounds.controls).toHaveLength(4);
  expect(Math.max(...actionBounds.controls.map(({ right }) => right)))
    .toBeLessThanOrEqual(actionBounds.rowRight + 0.5);
  expect(Math.max(...actionBounds.controls.map(({ bottom }) => bottom)))
    .toBeLessThanOrEqual(actionBounds.rowBottom + 0.5);
  // D-233 moved authority to contracts and per-run approval; this layer is retired.
  await expect(grants).toHaveCount(0);
  await expect(page.locator(`[${CONNECTIONS_GRANT_TOGGLE}]`)).toHaveCount(0);
  expect(await page.evaluate(() => ({
    reads: window.__app.rpcCallCount('collection.connection.listOperationGroups'),
    grants: window.__app.rpcCallCount('collection.connection.grantOperationGroup'),
    revokes: window.__app.rpcCallCount('collection.connection.revokeOperationGroup'),
  }))).toEqual({ reads: 0, grants: 0, revokes: 0 });
  for (const name of ['Edit', 'Test connection', 'Remove']) {
    const action = enrolledRow.getByRole('button', { name, exact: true });
    await action.focus();
    await expect(action).toBeFocused();
    expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  }
});

test('Connections keeps long enrolled identities contained without operation grants', async ({ page }) => {
  const longName = `service-${'identity'.repeat(5)}`;
  const longDisplayName = `Connection${'Identity'.repeat(24)}`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?connection=grants&connection_text=long#connections/others`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  const row = route.locator('.connections-row').first();
  await expect(row.locator('.connections-row-name')).toHaveText(longDisplayName);
  await expect(row.locator('.connections-row-display')).toHaveText(longName);
  await expect(route.locator(`[${CONNECTIONS_GRANTS}]`)).toHaveCount(0);
  await expect(route.locator(`[${CONNECTIONS_GRANT_TOGGLE}]`)).toHaveCount(0);
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('collection.connection.listOperationGroups'),
  )).toBe(0);

  const bounds = await row.evaluate((element) => [
    element,
    ...element.querySelectorAll<HTMLElement>(
      '.connections-row-name, .connections-row-display, .connections-row-actions, button',
    ),
  ].map((node) => ({
    left: node.getBoundingClientRect().left,
    right: node.getBoundingClientRect().right,
    scroll: node.scrollWidth,
    client: node.clientWidth,
  })));
  for (const bound of bounds) {
    expect(bound.left).toBeGreaterThanOrEqual(-0.5);
    expect(bound.right).toBeLessThanOrEqual(280.5);
    expect(bound.scroll).toBeLessThanOrEqual(bound.client);
  }
  expect(await route.evaluate((node) => node.scrollWidth <= node.clientWidth))
    .toBe(true);
});

test('Connections contains long enrolled identities through removal review', async ({ page }) => {
  const longName = `service-${'identity'.repeat(5)}`;
  const longDisplayName = `Connection${'Identity'.repeat(24)}`;
  const longEndpoint = `https://${'endpoint'.repeat(7)}.example.test/v1`;
  // "Used by packs" names a pack by its name, not its slug (D-320 slice 2h), so
  // the long identity it must contain is the pack's name.
  const longPackName = `Pack${'N'.repeat(240)}`;
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&connection_text=long&pack_text=long#connections/others`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  const row = route.locator('.connections-row').first();
  await expect(row.locator('.connections-row-display')).toHaveText(longName);
  await expect(row.locator('.connections-row-name')).toHaveText(
    longDisplayName,
  );
  await expect(row.locator('.connections-row-summary')).toHaveText(longEndpoint);
  const usage = route.locator('.connections-pack-usage');
  await expect(usage.locator('.connections-pack-usage-name')).toHaveText(
    longPackName,
  );
  await expect(usage.locator('.connections-pack-usage-status')).toContainText(
    'missing crm.objects.deals.write',
  );

  const listGeometry = await route.locator('.connections-page').evaluate((page) => {
    const routeHost = page.closest<HTMLElement>('[data-recued-connections-route]');
    const selectors = [
      '.connections-group',
      '.connections-group-rows',
      '.connections-row-wrap',
      '.connections-row',
      '.connections-row-info',
      '.connections-row-name',
      '.connections-row-summary',
      '.connections-row-display',
      '.connections-row-actions',
      '.connections-pack-usage',
      '.connections-pack-usage-item',
      '.connections-pack-usage-name',
      '.connections-pack-usage-status',
    ];
    const elements = [
      page,
      ...selectors.map((selector) => page.querySelector<HTMLElement>(selector)),
    ].filter((element): element is HTMLElement => element !== null);
    return {
      routeScrollWidth: routeHost?.scrollWidth ?? 0,
      routeClientWidth: routeHost?.clientWidth ?? 0,
      elements: elements.map((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        localEllipsis: element.matches('.connections-row-summary'),
        overflow: getComputedStyle(element).overflow,
      })),
    };
  });
  expect(listGeometry.routeScrollWidth)
    .toBeLessThanOrEqual(listGeometry.routeClientWidth);
  for (const bounds of listGeometry.elements) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    if (bounds.localEllipsis) {
      expect(bounds.overflow).toBe('hidden');
    } else {
      expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
    }
  }

  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  const dialog = route.getByRole('dialog', {
    name: `Remove connection ${longName}`,
  });
  await expect(dialog.locator('.connections-delete-title')).toHaveText(
    `Remove ${longName}?`,
  );
  const dialogGeometry = await dialog.evaluate((surface) => {
    const elements = [
      surface,
      surface.querySelector<HTMLElement>('.connections-delete-title'),
      surface.querySelector<HTMLElement>('.connections-delete-body'),
      surface.querySelector<HTMLElement>('.connections-delete-actions'),
    ].filter((element): element is HTMLElement => element !== null);
    return elements.map((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
  });
  for (const bounds of dialogGeometry) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  }
});

test('Connections keeps custom credential headers usable on a narrow phone', async ({ page }) => {
  const longName = `service-${'identity'.repeat(5)}`;
  const longDisplayName = `Connection${'Identity'.repeat(24)}`;
  const longEndpoint = `https://${'endpoint'.repeat(7)}.example.test/v1`;
  const longHeaderName = `X-${'Credential'.repeat(10)}`;
  const longHeaderValue = 'secret'.repeat(40);
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1#connections/others`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  await route.getByRole('button', { name: /Add Connection/ }).click();
  await route.getByRole('button', { name: /HTTP API/ }).click();
  await route.locator('[data-conn-field="name"]').fill(longName);
  await route.locator('[data-conn-field="display_name"]').fill(longDisplayName);
  await route.locator('[data-conn-field="config.base_url"]').fill(longEndpoint);
  await route.locator('[data-conn-field="auth.type"]').selectOption('header');

  const headerName = route.getByRole('textbox', { name: 'Header 1 name' });
  const headerValue = route.getByLabel('Header 1 value');
  await headerName.fill(longHeaderName);
  await headerValue.fill(longHeaderValue);
  await expect(headerName).toHaveValue(longHeaderName);
  await expect(headerValue).toHaveValue(longHeaderValue);

  const geometry = await route.locator('.connections-header-list').evaluate((list) => {
    const routeHost = list.closest<HTMLElement>('[data-recued-connections-route]');
    const dialog = list.closest<HTMLElement>('.connections-dialog');
    const row = list.querySelector<HTMLElement>('.connections-header-row');
    const name = list.querySelector<HTMLElement>('.connections-header-name');
    const value = list.querySelector<HTMLElement>('.connections-header-value');
    const remove = list.querySelector<HTMLElement>('.connections-header-remove');
    const elements = [list, row, name, value, remove]
      .filter((element): element is HTMLElement => element !== null);
    return {
      routeScrollWidth: routeHost?.scrollWidth ?? 0,
      routeClientWidth: routeHost?.clientWidth ?? 0,
      dialogScrollWidth: dialog?.scrollWidth ?? 0,
      dialogClientWidth: dialog?.clientWidth ?? 0,
      nameWidth: name?.getBoundingClientRect().width ?? 0,
      valueWidth: value?.getBoundingClientRect().width ?? 0,
      elements: elements.map((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
      })),
    };
  });
  expect(geometry.routeScrollWidth).toBeLessThanOrEqual(geometry.routeClientWidth);
  expect(geometry.dialogScrollWidth).toBeLessThanOrEqual(geometry.dialogClientWidth);
  expect(geometry.nameWidth).toBeGreaterThan(150);
  expect(geometry.valueWidth).toBeGreaterThan(95);
  for (const bounds of geometry.elements) {
    expect(bounds.left).toBeGreaterThanOrEqual(-0.5);
    expect(bounds.right).toBeLessThanOrEqual(280.5);
  }
});

test('Connections recovers pack usage and setup context explicitly', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&recipes=installed&packs_response=detail-fail-once-slow-retry&connection=grants#recipes`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('packs.list'),
  )).toBe(1);

  await page.evaluate(() => window.__app.setHash('#connections/others'));
  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  const recovery = route.locator(`[${CONNECTIONS_PACK_INVENTORY}]`);
  await expect(recovery).toHaveAttribute(CONNECTIONS_PACK_INVENTORY, 'error');
  await expect(recovery).toHaveAttribute('role', 'alert');
  await expect(recovery).toContainText('Recued cannot read the Pack details');

  const retry = recovery.locator(`[${CONNECTIONS_PACK_INVENTORY_RETRY}]`);
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(recovery).toHaveAttribute(CONNECTIONS_PACK_INVENTORY, 'retrying');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('packs.list'),
  )).toBe(3);

  await expect(recovery).toBeHidden();
  await expect(route.getByRole('button', { name: /Add Connection/ }))
    .toBeFocused();
});

test('Connections serializes live pack-context refreshes without moving focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&connection=grants#connections/others`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('packs.list'),
  )).toBe(1);

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  const add = route.getByRole('button', { name: /Add Connection/ });
  await add.focus();
  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'pack_uninstalled',
      pack_slug: 'installed-mail',
      pack_name: 'Installed Mail',
      pack_version: 1,
      removed_recipe_count: 1,
      cursor: 71,
    },
  }));
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('packs.list'),
  )).toBe(2);

  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'pack_installed',
      pack_slug: 'installed-mail',
      pack_name: 'Installed Mail',
      pack_version: 1,
      installed_recipe_count: 1,
      cursor: 72,
    },
  }));
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('packs.list'),
  )).toBe(2);
  await expect.poll(() => page.evaluate(
    () => window.__app.rpcCallCount('packs.list'),
  )).toBe(3);
  const beforeLatestPaint = await add.elementHandle();
  expect(beforeLatestPaint).not.toBeNull();
  await page.waitForFunction(
    (element) => element?.isConnected === false,
    beforeLatestPaint,
  );
  await expect(add).toBeFocused();
});

test('a Connections account removal dialog owns and restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?connection=source-ready&account_delete_delay_ms=2500`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#connections'));

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  await route.locator(
    '[data-action="accounts-open-detail"][data-slug="work"]',
  ).click();
  const remove = route.getByRole('button', { name: 'Remove', exact: true });
  await remove.focus();
  await page.keyboard.press('Enter');

  const dialog = route.getByRole('dialog', { name: 'Remove account work' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(remove).toBeFocused();

  await remove.click();
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const confirm = dialog.getByRole('button', { name: 'Remove', exact: true });
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  const removing = dialog.getByRole('button', {
    name: 'Removing…',
    exact: true,
  });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await expect(removing).toHaveAttribute('aria-disabled', 'true');
  await expect(removing).toHaveAttribute('aria-busy', 'true');
  await expect(removing).not.toHaveAttribute('disabled');
  await expect(removing).toBeFocused();
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await expect(cancel).not.toHaveAttribute('aria-busy');
  await expect(cancel).not.toHaveAttribute('disabled');
  await removing.dispatchEvent('click');
  await cancel.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('collection.mail.delete')),
  ).toBe(1);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    window.__app.setHash('#chat');
  });

  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Connections is still doing something. Leave anyway?',
  );
  // Declining the route leave keeps the pending command on its exact account
  // detail. Completion then closes into the canonical Mail collection, which
  // remains the durable browser-Back parent for a later detail open.
  await expect(page).toHaveURL(/#connections\/mail\/work$/);
  await expect(removing).toBeFocused();

  const connect = route.getByRole('button', { name: 'Connect mailbox' });
  await expect(connect).toBeVisible();
  await expect(page).toHaveURL(/#connections\/mail$/);
  await expect(connect).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
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

  const discard = page.waitForEvent('dialog').then(async prompt => {
    expect(prompt.message()).toContain('Discard this account setup');
    await prompt.accept();
  });
  await route.getByRole('link', { name: 'Calendar' }).click();
  await discard;
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

test('a rejected mailbox enrollment keeps the busy and retry actions focused', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?connection=imap-fail`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#connections'));

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  await route.getByRole('button', { name: 'Connect mailbox' }).click();
  await route.getByRole('button', { name: /IMAP \/ SMTP/ }).click();
  await route.getByRole('textbox', { name: 'Name', exact: true }).fill('fastmail');
  await route.getByRole('textbox', { name: 'IMAP Host', exact: true })
    .fill('imap.fastmail.com');
  await route.getByRole('textbox', { name: 'Username', exact: true })
    .fill('me@example.com');
  const password = route.getByLabel('Password', { exact: true });
  await password.fill('app-password');

  const submit = route.getByRole('button', { name: 'Connect account' });
  await submit.focus();
  await page.keyboard.press('Enter');

  const busy = route.getByRole('button', { name: 'Connecting…' });
  await expect(busy).toHaveAttribute('aria-disabled', 'true');
  await expect(busy).toHaveAttribute('aria-busy', 'true');
  await expect(busy).toBeFocused();

  await expect(route.getByRole('alert')).toContainText(
    'The mailbox credentials were rejected.',
  );
  await expect(submit).toBeFocused();

  // The first corrective input clears the stale alert by repainting the form.
  // Keep both field ownership and the post-input caret across that repaint.
  await password.focus();
  await password.evaluate((element: HTMLInputElement) => element.setSelectionRange(3, 3));
  await page.keyboard.type('Z');
  await expect(route.getByRole('alert')).toHaveCount(0);
  await expect(password).toHaveValue('appZ-password');
  await expect(password).toBeFocused();
  expect(await password.evaluate((element: HTMLInputElement) => element.selectionStart)).toBe(4);
});

test('the first mailbox enrolment ends by opening Proposals', async ({ page }) => {
  // D-325 §15.5: the first session ends on Yours → Proposals, where what was
  // read from that mailbox is proposed. A later mailbox stays on Connections
  // (the next two tests).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?connection=imap-success`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#connections'));

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  await route.getByRole('button', { name: 'Connect mailbox' }).click();
  await route.getByRole('button', { name: /IMAP \/ SMTP/ }).click();
  await route.getByRole('textbox', { name: 'Name', exact: true }).fill('fastmail');
  await route.getByRole('textbox', { name: 'IMAP Host', exact: true })
    .fill('imap.fastmail.com');
  await route.getByRole('textbox', { name: 'Username', exact: true })
    .fill('me@example.com');
  await route.getByLabel('Password', { exact: true }).fill('app-password');
  await route.getByRole('button', { name: 'Connect account' }).click();

  await expect(page).toHaveURL(/#yours\/proposals$/);
  await expect(route).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Yours', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What is read' })).toBeVisible();
});

test('a successful IMAP enrollment confirms the connected account in focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // A second mailbox: the first one's enrolment ends on Proposals instead.
  await page.goto(`${HARNESS_URL}?connection=imap-success&mail_existing=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#connections'));

  const route = page.locator(`[${CONNECTIONS_ROUTE}]`);
  await route.getByRole('button', { name: 'Connect mailbox' }).click();
  await route.getByRole('button', { name: /IMAP \/ SMTP/ }).click();
  await route.getByRole('textbox', { name: 'Name', exact: true }).fill('fastmail');
  await route.getByRole('textbox', { name: 'IMAP Host', exact: true })
    .fill('imap.fastmail.com');
  await route.getByRole('textbox', { name: 'Username', exact: true })
    .fill('me@example.com');
  await route.getByLabel('Password', { exact: true }).fill('app-password');
  await route.getByRole('button', { name: 'Connect account' }).click();

  const success = route.locator(`[${ACCOUNT_CONNECTION_SUCCESS}]`);
  await expect(success).toBeVisible();
  await expect(success).toHaveAttribute('data-sync-state', 'ready');
  await expect(success).toBeFocused();
  await expect(success.getByRole('heading', {
    name: 'IMAP / SMTP is ready',
  })).toBeVisible();
  await expect(success).toContainText('me@example.com');
  await expect(success.getByRole('button', {
    name: 'Ask about this account',
  })).toBeVisible();

  const dismiss = success.getByRole('button', { name: 'Dismiss' });
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(route.locator(
    '[data-action="accounts-open-detail"][data-slug="fastmail"]',
  )).toBeFocused();
});

test('a connected mailbox hands its first useful question into Chat', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // A second mailbox: the first one's enrolment ends on Proposals instead.
  await page.goto(`${HARNESS_URL}?connection=first-sync&mail_existing=1`);
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
  await expect(success.getByRole('heading', { name: 'Gmail sign-in saved' })).toBeVisible();
  await expect(success).toContainText('person@example.com');
  await expect(success).toContainText('Checking mailbox access');
  await expect(success).toContainText('checking and syncing continue on your server');
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
  await expect(handoff.getByRole('heading', { name: 'Gmail sign-in saved' })).toBeVisible();
  await expect(handoff).toContainText('person@example.com');
  await expect(handoff).toContainText('checking mailbox access in the background');
  await expect(page.locator(`[${CHAT_ACTIVATION}]`)).toHaveCount(0);
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue('');
  await page.screenshot({
    path: `${ARTIFACTS}/full-app-chat-connected-source-pending-mobile.png`,
    fullPage: true,
  });

  // Chat keeps checking after Connections unmounts. Verified access is useful
  // before the import finishes, but must not claim complete history or send.
  const pendingScrollY = await page.evaluate(() => window.scrollY);
  await expect(handoff).toHaveAttribute('data-state', 'syncing');
  await expect(handoff).toContainText('Mailbox access is verified');
  await expect(page.locator(`[${CHAT_INPUT}]`)).toHaveValue('');
  await expect(handoff).toHaveAttribute('data-state', 'ready');
  await expect(handoff).toBeFocused();
  await expect(handoff.getByRole('heading', { name: 'Gmail is ready for Chat' })).toBeVisible();
  await expect(handoff).toContainText('Here is a first question you could ask');
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
    name: 'Use Chat without it',
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
    .toHaveText('Checking what it did');
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
    .toHaveText('Mail search finished');
  await expect(answer).toContainText(
    'It does not say which records, if any, went into the answer.',
  );
  const references = answer.locator(`[${CHAT_SOURCE_REFERENCES}]`);
  await expect(references).toHaveAttribute(SHARED_REFERENCE_DISCLOSURE, '');
  const referencesToggle = references.locator(
    `[${CHAT_SOURCE_REFERENCES_TOGGLE}]`,
  );
  await expect(referencesToggle).toContainText('2 recorded references');
  await expect(referencesToggle).toContainText(
    'Where it came from, and which records',
  );
  await expect(referencesToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(references.locator(`[${CHAT_SOURCE_REFERENCE}]`)).toHaveCount(0);
  await referencesToggle.click();
  await expect(referencesToggle).toBeFocused();
  await expect(referencesToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(references).toContainText(
    'They are not tied to any one sentence yet.',
  );
  await expect(references.locator(`[${CHAT_SOURCE_REFERENCE}]`)).toHaveCount(2);
  await expect(references.locator(`[${SHARED_REFERENCE_ITEM}]`)).toHaveCount(2);
  await expect(references.locator(`[${CHAT_SOURCE_REFERENCE_ID}]`))
    .toHaveText([
      'mail-1',
      'mail:message:01J4X9Z8V7W6T5S4R3Q2P1N0M9L8K7J6',
    ]);
  await expect(references.locator(`[${CHAT_SOURCE_REFERENCE_ID}]`).nth(0))
    .toHaveAttribute(SHARED_REFERENCE, 'identity');
  await expect(references.locator(`[${CHAT_SOURCE_REFERENCE_ID}]`).nth(0))
    .toHaveAttribute(SHARED_REFERENCE_ID, 'mail-1');
  await expect(references.locator(`[${CHAT_SOURCE_REFERENCE_ID}]`).nth(1))
    .toHaveAttribute(SHARED_REFERENCE, 'identity');
  await expect(references.locator(`[${CHAT_SOURCE_REFERENCE_ID}]`).nth(1))
    .toHaveAttribute(
      SHARED_REFERENCE_ID,
      'mail:message:01J4X9Z8V7W6T5S4R3Q2P1N0M9L8K7J6',
    );
  await expect(references).toContainText('Quarterly planning');
  await expect(references).toContainText('Launch readiness');
  const recordLinks = references.locator(`[${CHAT_SOURCE_REFERENCE_OPEN}]`);
  await expect(recordLinks).toHaveCount(2);
  await expect(recordLinks.nth(0)).toHaveAttribute(SHARED_REFERENCE, 'link');
  await expect(recordLinks.nth(1)).toHaveAttribute(SHARED_REFERENCE, 'link');
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
    'Pick what to do next and Recued will put it in the message box. '
    + 'None of these send email or change your things.',
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
    .toHaveText(['Write the replies', 'Make a to-do list']);
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

  await answer.getByRole('button', { name: 'Write the replies' }).click();
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
  await expect(followupContext).toContainText('Asks for a new mail search');
  await expect(followupContext).toContainText(
    'If you ask it to send email, you will say yes separately.',
  );
  await expect(input).toHaveAttribute(
    'placeholder',
    'Read or change this…',
  );
  await expect(page.locator(`[${CHAT_SEND}]`)).toHaveText('Ask Chat');
  const followupDescriptionId = await input.getAttribute('aria-describedby');
  if (followupDescriptionId === null) {
    throw new Error('source-aware follow-up did not describe the composer');
  }
  await expect(page.locator(`#${followupDescriptionId}`)).toContainText(
    'Asks for a new mail search',
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

  await answer.getByRole('button', { name: 'Make a to-do list' }).click();
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
    'Carries on from the last answer · nothing new searched',
  );
  await expect(followupContext).toContainText(
    'To-do list, most important first · Gmail · person@example.com',
  );
  await expect(followupContext).toContainText(
    'If you ask it to make tasks, you will say yes separately.',
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
    'To-do list, most important first · Gmail · person@example.com',
  );
  await expect(page.locator(`[${CHAT_ANSWER_WAITING}]`))
    .toHaveText('Carrying on from the last answer…');
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
  ).toHaveText('Nothing new was searched');
  await expect(sourceAnswers.nth(1)).toContainText(
    'No new mail search was noted.',
  );
  await expect(
    sourceAnswers.nth(0).locator(`[${CHAT_SOURCE_ANSWER_ACTION}]`),
  ).toHaveCount(0);
  await expect(
    sourceAnswers.nth(1).locator(`[${CHAT_SOURCE_ANSWER_ACTION}="draft"]`),
  ).toHaveText(['Write the replies']);
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
  // Older receipts must keep their intrinsic height inside the thread scroller.
  // A compressed card can look visible while its reference button is clipped.
  const answerHeights = await sourceAnswers.evaluateAll((cards) => cards.map(
    (card) => ({ client: card.clientHeight, scroll: card.scrollHeight }),
  ));
  for (const height of answerHeights) {
    expect(height.scroll).toBeLessThanOrEqual(height.client);
  }
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

  const discard = page.waitForEvent('dialog').then(async prompt => {
    expect(prompt.message()).toContain('Discard this account setup');
    await prompt.accept();
  });
  await route.getByRole('link', { name: 'Calendar' }).click();
  await discard;
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
