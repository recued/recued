import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

/** Reception Inbox, Records, and Responses browser journeys. */
const RECEPTION_INBOX_ROW = 'data-recued-reception-inbox-row';
const RECEPTION_INBOX_DETAIL_HEADING =
  'data-recued-reception-inbox-detail-heading';
const RECEPTION_INBOX_REFRESH = 'data-recued-reception-inbox-refresh';
const RECEPTION_INBOX_DESTINATION_ERROR =
  'data-recued-reception-inbox-destination-error';
const RECEPTION_INBOX_DESTINATION_RETRY =
  'data-recued-reception-inbox-destination-retry';
const RECEPTION_RECORDS_ERROR = 'data-recued-reception-records-error';
const RECEPTION_RECORDS_KIND = 'data-recued-reception-records-kind';
const RECEPTION_RECORDS_RETRY = 'data-recued-reception-records-retry';
const RECEPTION_RESPONSES_ERROR = 'data-recued-reception-response-error';
const RECEPTION_RESPONSES_RETRY = 'data-recued-reception-response-retry';
const RECEPTION_RESPONSE_DETAIL_RETRY =
  'data-recued-reception-response-detail-retry';

installFullAppHooks();

test('Reception distinguishes its section navigation from the app drawer', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?reception=pending`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception'));

  const route = page.locator('[data-recued-reception-route]');
  await expect(route.getByRole('heading', {
    name: 'Reception Inbox',
    level: 2,
  })).toBeVisible();
  await expect(route.getByRole('heading', {
    name: 'Commitments',
    level: 3,
  })).toBeVisible();
  await expect(route.getByRole('heading', {
    name: 'Follow up with Morgan',
    level: 3,
  })).toBeVisible();

  const sections = page.getByRole('navigation', {
    name: 'Reception sections',
  });
  await expect(sections).toHaveCount(1);
  await expect(sections.getByRole('link')).toHaveText([
    'Inbox',
    'Customer work',
    'Records',
    'Manage',
  ]);
  await expect(page.locator('nav[aria-label="Primary navigation"]'))
    .toHaveCount(1);

  await sections.getByRole('link', { name: 'Manage' }).click();
  await page.getByRole('navigation',{name:'Manage Reception'}).getByRole('link',{name:'Abuse',exact:true}).click();
  const abuse = page.getByRole('region', { name: 'Abuse signals' });
  await expect(abuse.getByRole('heading', {
    name: 'Abuse signals',
    level: 2,
  })).toBeAttached();

  await page.getByRole('navigation',{name:'Manage Reception'}).getByRole('link',{name:'Endpoints',exact:true}).click();
  await expect(page.getByRole('heading', {
    name: 'Endpoints',
    level: 2,
  })).toBeVisible();
  await expect(page.getByRole('heading', {
    name: 'Endpoint inventory',
    level: 3,
  })).toBeVisible();
});

test('Reception contains long inbox identities across list and detail', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?reception=pending&reception_text=long#reception`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const longTitle = `Follow${'T'.repeat(240)}`;
  const route = page.locator('[data-recued-reception-route]');
  const row = route.locator(
    '[data-recued-reception-inbox-row="hold-reception-1"]',
  );
  const heading = route.locator(
    '[data-recued-reception-inbox-detail-heading="hold-reception-1"]',
  );
  await expect(row.locator('.reception-inbox-row-title')).toHaveText(longTitle);
  await expect(heading).toHaveText(longTitle);
  await expect(row).toHaveAttribute('aria-selected', 'true');

  const owners = route.locator(
    ':scope, [data-recued-reception-route-content], '
      + '.reception-inbox-shell, '
      + '.reception-inbox-head, .reception-inbox-body, '
      + '.reception-inbox-list, .reception-inbox-group, '
      + '.reception-inbox-row, .reception-inbox-row-title, '
      + '.reception-inbox-row-subtitle, .reception-inbox-detail, '
      + '.reception-inbox-detail-title, .reception-inbox-detail-subtitle, '
      + '.reception-inbox-toolbar, .reception-inbox-chip, '
      + '.reception-inbox-form, .reception-inbox-field',
  );
  expect(await owners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);

  const tabs = route.locator(
    '[data-recued-reception-route-tabs] .reception-route-tab',
  );
  const rail=route.locator('[data-recued-reception-route-tabs]');await expect(rail).toHaveCSS('overflow-x','auto');
  const active=rail.locator('[aria-current=page]');await expect(active).toBeInViewport();
  for(const tab of await tabs.all()){await tab.focus();const box=await tab.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(280);}

});

test('Reception recovers destination inventory without losing query ownership', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?reception=pending`
    + '&reception_destination_response=fail-once-slow-retry'
    + '&hold_rpc=work_entity.source.list'
    + '#reception',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const picker = page.getByRole('combobox', { name: 'Destination' });
  await expect(picker).toBeVisible();
  await picker.fill('Tas');
  await picker.evaluate((input) => {
    (input as HTMLInputElement).setSelectionRange(2, 2);
  });
  await expect(page.getByText('Nothing matches.')).toHaveCount(0);
  expect(await page.evaluate(
    () => window.__app.releaseRpcResponses?.('work_entity.source.list'),
  )).toBe(1);

  const failure = page.locator(
    `[${RECEPTION_INBOX_DESTINATION_ERROR}="source_id"]`,
  );
  await expect(failure).toHaveAttribute('role', 'alert');
  await expect(failure).toContainText('Recued could not load where it can go:');
  await expect(picker).toHaveCount(0);
  const retry = page.locator(
    `[${RECEPTION_INBOX_DESTINATION_RETRY}="source_id"]`,
  );
  await expect(retry).toBeFocused();

  const callsBeforeRetry = await page.evaluate(
    () => window.__app.rpcCallCount('work_entity.source.list'),
  );
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).toBeFocused();
  await retry.dispatchEvent('click');
  await retry.dispatchEvent('click');
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('work_entity.source.list'),
  )).toBe(callsBeforeRetry + 1);
  expect(await page.evaluate(
    () => window.__app.releaseRpcResponses?.('work_entity.source.list'),
  )).toBe(1);

  await expect(picker).toBeVisible();
  await expect(picker).toHaveValue('Tas');
  await expect(picker).toBeFocused();
  expect(await picker.evaluate((input) =>
    (input as HTMLInputElement).selectionStart)).toBe(2);
  await expect(failure).toHaveCount(0);
});

test('Reception moves focus into a selected inbox detail and preserves it through refresh', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?reception=pending`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception'));

  const row = page.locator(
    `[${RECEPTION_INBOX_ROW}="hold-reception-2"]`,
  );
  await expect(row).toBeVisible();
  await row.focus();
  await page.keyboard.press('Enter');

  const heading = page.locator(
    `[${RECEPTION_INBOX_DETAIL_HEADING}="hold-reception-2"]`,
  );
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(heading).toHaveText('Prepare the launch brief');
  await expect(heading).toHaveAttribute('tabindex', '-1');
  await expect(heading).toBeFocused();
  await expect(page.getByRole('form', {
    name: 'Prepare the launch brief',
  })).toBeVisible();

  const listCalls = await page.evaluate(
    () => window.__app.rpcCallCount('reception.inbox.list'),
  );
  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'reception_inbox',
        op: 'approved',
        hold_id: 'hold-reception-external',
        cursor: 20,
      },
    });
  });
  await page.waitForFunction(
    (previous) => window.__app.rpcCallCount('reception.inbox.list') > previous,
    listCalls,
  );
  await expect(heading).toBeFocused();
});

test('Reception preserves an unsaved decision draft through refresh', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?reception=pending`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception'));

  const title = page.getByLabel('Title', { exact: true });
  const reason = page.getByLabel('Why you are saying no', { exact: true });
  await expect(title).toBeVisible();
  await expect(reason).toBeVisible();
  await title.fill('Follow up with Morgan after review');
  await reason.fill('Need the owner to confirm the account.');
  await title.focus();
  await title.evaluate((field: HTMLInputElement) => {
    field.setSelectionRange(14, 14);
  });

  const listCalls = await page.evaluate(
    () => window.__app.rpcCallCount('reception.inbox.list'),
  );
  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'reception_inbox',
        op: 'held',
        hold_id: 'hold-reception-external',
        cursor: 21,
      },
    });
  });
  await page.waitForFunction(
    (previous) => window.__app.rpcCallCount('reception.inbox.list') > previous,
    listCalls,
  );

  await expect(title).toHaveValue('Follow up with Morgan after review');
  await expect(reason).toHaveValue('Need the owner to confirm the account.');
  await expect(title).toBeFocused();
  await expect.poll(() => title.evaluate((field: HTMLInputElement) => ({
    start: field.selectionStart,
    end: field.selectionEnd,
  }))).toEqual({ start: 14, end: 14 });
});

test('Reception advances focus after approving a selected inbox item', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?reception=pending&reception_decision_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception'));

  const firstRow = page.locator(
    `[${RECEPTION_INBOX_ROW}="hold-reception-1"]`,
  );
  await expect(firstRow).toBeVisible();
  await firstRow.focus();
  await page.keyboard.press('Enter');

  const firstHeading = page.locator(
    `[${RECEPTION_INBOX_DETAIL_HEADING}="hold-reception-1"]`,
  );
  await expect(firstHeading).toBeFocused();
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
  });
  await approve.focus();
  await page.keyboard.press('Enter');

  const approving = page.getByRole('button', {
    name: 'Approving…',
    exact: true,
  });
  await expect(approving).toBeFocused();
  await expect(approving).not.toHaveAttribute('disabled');
  await expect(approving).toHaveAttribute('aria-disabled', 'true');
  await expect(approving).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => window.__app.setHash('#data'));
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A Reception action is still in progress. Leave Reception anyway?',
  );
  await expect(page).toHaveURL(/#reception$/);
  await expect(firstRow).toHaveCount(0);
  const nextRow = page.locator(
    `[${RECEPTION_INBOX_ROW}="hold-reception-2"]`,
  );
  const nextHeading = page.locator(
    `[${RECEPTION_INBOX_DETAIL_HEADING}="hold-reception-2"]`,
  );
  await expect(nextRow).toHaveAttribute('aria-selected', 'true');
  await expect(nextHeading).toHaveText('Prepare the launch brief');
  await expect(nextHeading).toBeFocused();
  await expect(approving).toHaveCount(0);
  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Reception keeps an acknowledged decision settled when refresh fails', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?reception=pending&reception_refresh_after_decision=fail`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception'));

  const firstRow = page.locator(
    `[${RECEPTION_INBOX_ROW}="hold-reception-1"]`,
  );
  await firstRow.focus();
  await page.keyboard.press('Enter');
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  await approve.focus();
  await page.keyboard.press('Enter');

  await expect(firstRow).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveText(
    "Saved. Recued could not reload your inbox: Reception refresh unavailable.",
  );
  const nextRow = page.locator(
    `[${RECEPTION_INBOX_ROW}="hold-reception-2"]`,
  );
  const nextHeading = page.locator(
    `[${RECEPTION_INBOX_DETAIL_HEADING}="hold-reception-2"]`,
  );
  await expect(nextRow).toHaveAttribute('aria-selected', 'true');
  await expect(nextHeading).toBeFocused();
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('reception.inbox.approve'),
    ),
  ).toBe(1);
});

test('Reception keeps manual Refresh focused and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?reception=pending&reception_refresh_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception'));

  const refresh = page.locator(`[${RECEPTION_INBOX_REFRESH}]`);
  await expect(refresh).toHaveText('Refresh');
  await expect(refresh).toBeEnabled();
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('reception.inbox.list'),
  );
  await refresh.focus();
  await page.keyboard.press('Enter');

  await expect(refresh).toHaveText('Refreshing…');
  await expect(refresh).toBeFocused();
  await expect(refresh).not.toHaveAttribute('disabled');
  await expect(refresh).toHaveAttribute('aria-disabled', 'true');
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
  await refresh.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('reception.inbox.list'),
    ),
  ).toBe(before + 1);
  await expect(refresh).toHaveText('Refresh');
  await expect(refresh).toBeFocused();
});

test('Reception keeps inbox view switches focused, selected, and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?reception=pending&reception_refresh_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception'));

  const open = page.getByRole('button', { name: 'Open', exact: true });
  const dismissed = page.getByRole('button', {
    name: 'Dismissed / expired',
    exact: true,
  });
  await expect(dismissed).toBeEnabled();
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('reception.inbox.list'),
  );
  await dismissed.focus();
  await page.keyboard.press('Enter');

  await expect(dismissed).toHaveAttribute('aria-disabled', 'true');
  await expect(dismissed).toHaveAttribute('aria-busy', 'true');
  await expect(dismissed).not.toHaveAttribute('disabled');
  await expect(dismissed).toBeFocused();
  await dismissed.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('reception.inbox.list'),
    ),
  ).toBe(before + 1);

  await expect(dismissed).toBeFocused();
  await expect(dismissed).toHaveAttribute('aria-pressed', 'true');
  await expect(open).toHaveAttribute('aria-pressed', 'false');
});

test('Reception Records lenses form one full-size arrow-key keyboard stop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception/records'));

  const records = page.getByRole('region', { name: 'Reception records' });
  await expect(records.getByRole('heading', {
    name: 'Reception records',
    level: 2,
  })).toBeAttached();

  const lenses = page.locator('[data-recued-reception-records-lens]');
  const requests = page.locator(
    '[data-recued-reception-records-lens="requests"]',
  );
  const responses = page.locator(
    '[data-recued-reception-records-lens="responses"]',
  );
  await expect(requests).toHaveAttribute('role', 'tab');
  await expect(requests).toHaveAttribute('aria-selected', 'true');
  await expect(requests).toHaveAttribute('tabindex', '0');
  expect(await lenses.evaluateAll((nodes) => nodes.filter(
    (node) => node.getAttribute('tabindex') === '0',
  ).length)).toBe(1);
  const lensHeights = await lenses.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height)
  );
  expect(Math.min(...lensHeights)).toBeGreaterThanOrEqual(36);

  await requests.focus();
  await page.keyboard.press('ArrowRight');
  await expect(responses).toHaveAttribute('aria-selected', 'true');
  await expect(responses).toHaveAttribute('tabindex', '0');
  await expect(responses).toBeFocused();
  await expect(page.locator(
    '[data-recued-reception-response-row="submission-0"]',
  )).toBeVisible();

  await page.keyboard.press('Home');
  await expect(requests).toHaveAttribute('aria-selected', 'true');
  await expect(requests).toBeFocused();
});

test('Reception Records filters retain focus and expose their selection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception/records'));

  const allKinds = page.locator(
    '[data-recued-reception-records-kind="all"]',
  );
  const bookings = page.locator(
    '[data-recued-reception-records-kind="scheduling_link"]',
  );
  await expect(allKinds).toHaveAttribute('aria-pressed', 'true');
  await expect(bookings).toHaveAttribute('aria-pressed', 'false');

  const filters = page.locator(
    `[${RECEPTION_RECORDS_KIND}], [data-recued-reception-records-outcome]`,
  );
  await expect(filters).toHaveCount(5);
  const filterHeights = await filters.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height)
  );
  expect(Math.min(...filterHeights)).toBeGreaterThanOrEqual(36);

  await bookings.click();
  await expect(bookings).toHaveAttribute('aria-pressed', 'true');
  await expect(allKinds).toHaveAttribute('aria-pressed', 'false');
  await expect(bookings).toBeFocused();
});

test('Reception Records keeps Retry focused and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?reception_records_response=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception/records'));

  const error = page.locator(`[${RECEPTION_RECORDS_ERROR}]`);
  await expect(error).toHaveAttribute('role', 'alert');
  const retry = page.locator(`[${RECEPTION_RECORDS_RETRY}]`);
  await expect(retry).toHaveText('Retry');
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('reception.record.list'),
  );
  await retry.focus();
  await page.keyboard.press('Enter');

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toBeFocused();
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await retry.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('reception.record.list'),
    ),
  ).toBe(before + 1);
  await expect(error).toHaveCount(0);
  await expect(page.locator(
    `[${RECEPTION_RECORDS_KIND}="all"]`,
  )).toBeFocused();
});

test('Reception Records returns a failed Retry to its alert action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?reception_records_response=fail-twice-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception/records'));

  const retry = page.locator(`[${RECEPTION_RECORDS_RETRY}]`);
  await expect(retry).toHaveText('Retry');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');

  await expect(retry).toHaveText('Retry');
  await expect(retry).toBeFocused();
  await expect(page.locator(
    `[${RECEPTION_RECORDS_ERROR}]`,
  )).toHaveAttribute('role', 'alert');
});

test('Reception Responses moves focus into detail and back to its row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception/records'));
  await page.locator(
    '[data-recued-reception-records-lens="responses"]',
  ).click();

  const row = page.locator(
    '[data-recued-reception-response-row="submission-0"] button',
  );
  await row.click();

  const detail = page.locator(
    '[data-recued-reception-response-detail="submission-0"]',
  );
  const heading = detail.getByRole('heading', { level: 2 });
  await expect(heading).toHaveText('visitor-0@example.test');
  await expect(heading).toBeFocused();
  const detailActions = detail.locator('button, a[href]');
  await expect(detailActions).toHaveCount(3);
  const detailActionHeights = await detailActions.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height)
  );
  expect(Math.min(...detailActionHeights)).toBeGreaterThanOrEqual(36);

  await detail.getByRole('button', { name: 'Back to form responses' }).click();
  await expect(row).toBeFocused();
});

test('Reception Responses contains long identities without splitting status', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=form-responses-paged&form_response_text=long`
      + '#reception/records',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(
    '[data-recued-reception-records-lens="responses"]',
  ).click();

  const visitor = `${'visitor'.repeat(8)}@example.test`;
  const route = page.locator('[data-recued-reception-route]');
  const responses = route.locator('[data-recued-reception-responses]');
  const row = responses.locator(
    '[data-recued-reception-response-row="submission-0"]',
  );
  await expect(row.locator('strong')).toHaveText(visitor);
  expect(await row.evaluate(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  )).toBe(true);
  await row.locator('button').click();

  const detail = responses.locator(
    '[data-recued-reception-response-detail="submission-0"]',
  );
  const heading = detail.getByRole('heading', { level: 2 });
  const status = detail.locator(
    '.reception-responses-header .reception-responses-pill',
  );
  await expect(heading).toHaveText(visitor);
  await expect(heading).toBeFocused();
  await expect(status).toHaveText('Accepted');
  expect(await status.evaluate(
    (element) => getComputedStyle(element).whiteSpace,
  )).toBe('nowrap');
  expect((await status.boundingBox())?.height).toBeLessThan(28);

  const owners = detail.locator(
    ':scope, .reception-responses-header, .reception-responses-header > *, '
      + '.reception-responses-meta, .reception-responses-meta > *, '
      + '.reception-responses-automation, '
      + '.reception-responses-automation-actions, '
      + '.reception-responses-fields, .reception-responses-fields > *',
  );
  expect(await owners.evaluateAll((elements) => elements.every(
    (element) => element.scrollWidth <= element.clientWidth + 1,
  ))).toBe(true);
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
});

test('Reception Responses pagination keeps a useful focus owner', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception/records'));
  await page.locator(
    '[data-recued-reception-records-lens="responses"]',
  ).click();

  const loadMore = page.getByRole('button', { name: 'Load more' });
  const loadMoreBox = await loadMore.boundingBox();
  expect(loadMoreBox?.height).toBeGreaterThanOrEqual(36);
  await loadMore.click();
  await expect(page.locator(
    '[data-recued-reception-response-row="submission-1"]',
  )).toBeVisible();
  await expect(loadMore).toBeFocused();

  await loadMore.click();
  const finalRow = page.locator(
    '[data-recued-reception-response-row="submission-2"] button',
  );
  await expect(finalRow).toBeVisible();
  await expect(loadMore).toHaveCount(0);
  await expect(finalRow).toBeFocused();
});

test('Reception Responses advances focus into the automation picker', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception/records'));
  await page.locator(
    '[data-recued-reception-records-lens="responses"]',
  ).click();
  await page.locator(
    '[data-recued-reception-response-row="submission-0"] button',
  ).click();

  const discover = page.locator(
    '.reception-responses-automation-actions '
      + '[data-recued-reception-response-action="discover"]',
  );
  await expect(discover).toHaveAccessibleName('Run this response');
  await discover.focus();
  const readsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('recipe.list'),
  );
  await page.evaluate((actionAttr) => {
    const selector = `.reception-responses-automation-actions [${actionAttr}="discover"]`;
    document.querySelector<HTMLElement>(selector)?.click();
    document.querySelector<HTMLElement>(selector)?.click();
  }, 'data-recued-reception-response-action');

  await expect(discover).toHaveText('Looking for things that can run…');
  await expect(discover).toHaveAttribute('aria-disabled', 'true');
  await expect(discover).toHaveAttribute('aria-busy', 'true');
  await expect(discover).not.toHaveAttribute('disabled');
  await expect(discover).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('recipe.list')),
  ).toBe(readsBefore + 1);

  const pickerHeading = page.locator(
    '[data-recued-reception-response-picker="ready"]',
  ).getByRole('heading', { level: 3 });
  await expect(pickerHeading).toHaveText('Run this response now');
  await expect(pickerHeading).toBeFocused();
});

test('Reception Responses distinguishes automation actions and restores their focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?data=form-responses-paged`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception/records'));
  await page.locator(
    '[data-recued-reception-records-lens="responses"]',
  ).click();
  await page.locator(
    '[data-recued-reception-response-row="submission-0"] button',
  ).click();
  await page.locator(
    '.reception-responses-automation-actions '
      + '[data-recued-reception-response-action="discover"]',
  ).click();

  const exactForm = page.getByRole('button', {
    name: 'Look at it and run Review project intake (project-intake-review)',
    exact: true,
  });
  const allForms = page.getByRole('button', {
    name: 'Look at it and run Review every intake (all-intakes-review)',
    exact: true,
  });
  await expect(exactForm).toHaveCount(1);
  await expect(allForms).toHaveCount(1);
  const pickerActions = page.locator(
    '[data-recued-reception-responses] button:visible, '
      + '[data-recued-reception-responses] a[href]:visible',
  );
  const pickerActionHeights = await pickerActions.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height)
  );
  expect(Math.min(...pickerActionHeights)).toBeGreaterThanOrEqual(36);

  await allForms.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await expect(dialog).toBeFocused();
  await expect(dialog).toContainText('Review every intake');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(allForms).toBeFocused();

  await exactForm.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeFocused();
  await expect(dialog).toContainText('Review project intake');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(exactForm).toBeFocused();
});

test('Reception Responses keeps list Retry focused and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=form-responses-paged&reception_responses_response=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception/records'));
  await page.locator(
    '[data-recued-reception-records-lens="responses"]',
  ).click();

  const error = page.locator(`[${RECEPTION_RESPONSES_ERROR}]`);
  const retry = page.locator(`[${RECEPTION_RESPONSES_RETRY}]`);
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(retry).toHaveText('Retry');
  await retry.focus();
  const readsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('form_response.list'),
  );
  await page.evaluate((retryAttr) => {
    document.querySelector<HTMLElement>(`[${retryAttr}]`)?.click();
    document.querySelector<HTMLElement>(`[${retryAttr}]`)?.click();
  }, RECEPTION_RESPONSES_RETRY);

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('form_response.list')),
  ).toBe(readsBefore + 1);

  await expect(error).toHaveCount(0);
  await expect(page.getByRole('heading', {
    name: /Form responses/,
    level: 2,
  })).toBeFocused();
  await expect(page.locator(
    '[data-recued-reception-response-row="submission-0"]',
  )).toBeVisible();
});

test('Reception Responses returns a failed list Retry to its alert action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=form-responses-paged&reception_responses_response=fail-twice-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception/records'));
  await page.locator(
    '[data-recued-reception-records-lens="responses"]',
  ).click();

  const retry = page.locator(`[${RECEPTION_RESPONSES_RETRY}]`);
  await expect(retry).toHaveText('Retry');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');

  await expect(retry).toHaveText('Retry');
  await expect(retry).toBeFocused();
  await expect(page.locator(
    `[${RECEPTION_RESPONSES_ERROR}]`,
  )).toHaveAttribute('role', 'alert');
});

test('Reception Responses keeps detail Retry focused and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=form-responses-paged&reception_response_detail=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception/records'));
  await page.locator(
    '[data-recued-reception-records-lens="responses"]',
  ).click();
  await page.locator(
    '[data-recued-reception-response-row="submission-0"] button',
  ).click();

  const error = page.locator(`[${RECEPTION_RESPONSES_ERROR}]`);
  const retry = page.locator(`[${RECEPTION_RESPONSE_DETAIL_RETRY}]`);
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(retry).toHaveText('Retry');
  await retry.focus();
  const readsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('form_response.get'),
  );
  await page.evaluate((retryAttr) => {
    document.querySelector<HTMLElement>(`[${retryAttr}]`)?.click();
    document.querySelector<HTMLElement>(`[${retryAttr}]`)?.click();
  }, RECEPTION_RESPONSE_DETAIL_RETRY);

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('form_response.get')),
  ).toBe(readsBefore + 1);

  const heading = page.locator(
    '[data-recued-reception-response-detail="submission-0"]',
  ).getByRole('heading', { level: 2 });
  await expect(heading).toHaveText('visitor-0@example.test');
  await expect(heading).toBeFocused();
  await expect(error).toHaveCount(0);
});

test('Reception Responses returns a failed detail Retry to its alert action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?data=form-responses-paged&reception_response_detail=fail-twice-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#reception/records'));
  await page.locator(
    '[data-recued-reception-records-lens="responses"]',
  ).click();
  await page.locator(
    '[data-recued-reception-response-row="submission-0"] button',
  ).click();

  const retry = page.locator(`[${RECEPTION_RESPONSE_DETAIL_RETRY}]`);
  await expect(retry).toHaveText('Retry');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');

  await expect(retry).toHaveText('Retry');
  await expect(retry).toBeFocused();
  await expect(page.locator(
    `[${RECEPTION_RESPONSES_ERROR}]`,
  )).toHaveAttribute('role', 'alert');

  await page.getByRole('button', {
    name: 'Back to form responses',
  }).click();
  await expect(page.locator(
    `[${RECEPTION_RESPONSES_ERROR}]`,
  )).toHaveCount(0);
  await expect(page.locator(
    '[data-recued-reception-response-row="submission-0"] button',
  )).toBeFocused();
});
