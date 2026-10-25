import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

/** Approvals browser journeys against the deterministic full-app harness. */
const APPROVALS_REFRESH = 'data-recued-approvals-refresh';

installFullAppHooks();

for (const width of [280, 1280]) {
  test('Approvals shows the complete Records batch review at width ' + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${HARNESS_URL}?attention=pending&resource_review=records-batch#approvals`);
    await page.waitForFunction(() => window.__app?.ready === true);
    const card = page.locator('[data-recued-approvals-focus="ask-attention-1"]');
    const review = card.getByRole('region', { name: 'Reviewed changes' });
    await expect(review).toBeVisible();
    await expect(review).toContainText('Before: Does not exist');
    await expect(review).toContainText('Intermediate edit');
    await expect(review).toContainText('2. delete');
    await expect(review).toContainText('3. create');
    await expect(review).toContainText('Inserted note');
    await expect(review.locator('script')).toHaveCount(0);
    await review.focus();
    await expect(review).toBeFocused();
    await page.keyboard.press('End');
    await expect.poll(() => review.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator(`[${APPROVALS_REFRESH}]`).click();
    await expect(review).toBeVisible();
    await expect(review).toContainText('Recreated final note');
    await expect(card.getByRole('button', { name: 'Approve: Review Records batch', exact: true })).toBeEnabled();
  });
}

test('Approvals focuses an exact decision card and preserves it through a queue repaint', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?attention=pending`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(
    () => window.__app.setHash('#approvals/approval-attention-1'),
  );

  const card = page.locator(
    '[data-recued-approvals-focus="approval-attention-1"]',
  );
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-focused', 'true');
  await expect(card).toHaveAttribute('tabindex', '-1');
  await expect(card).toBeFocused();

  const listCalls = await page.evaluate(
    () => window.__app.rpcCallCount('approval.list'),
  );
  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'approval',
        subkind: 'pending',
        id: 'approval-attention-1',
        cursor: 20,
      },
    });
  });
  await page.waitForFunction(
    (previous) => window.__app.rpcCallCount('approval.list') > previous,
    listCalls,
  );
  await expect(card).toBeFocused();
});

test('Approvals keeps queue Refresh focused and single-flight', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=pending&approval_queue_response=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const error = page.locator('[data-recued-approvals-error="error"]');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText('Approval queue is temporarily unavailable.');
  const refresh = page.locator(`[${APPROVALS_REFRESH}]`);
  await expect(refresh).toHaveText('Refresh');
  const refreshBox = await refresh.boundingBox();
  expect(refreshBox?.height).toBeGreaterThanOrEqual(36);
  const before = await page.evaluate(
    () => window.__app.rpcCallCount('approval.list'),
  );
  await refresh.focus();
  await page.keyboard.press('Enter');

  await expect(refresh).toHaveText('Refreshing…');
  await expect(refresh).toHaveAttribute('aria-disabled', 'true');
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
  await expect(refresh).not.toHaveAttribute('disabled');
  await expect(refresh).toBeFocused();
  await refresh.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('approval.list')),
  ).toBe(before + 1);

  await expect(error).toHaveCount(0);
  await expect(refresh).toHaveText('Refresh');
  await expect(refresh).not.toHaveAttribute('aria-disabled');
  await expect(refresh).not.toHaveAttribute('aria-busy');
  await expect(refresh).toBeFocused();
});

test('Approvals gives repeated decision and handoff actions exact owners', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?attention=pending`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const decisions = page.getByRole('list', {
    name: 'Pending decisions',
  });
  await expect(page.getByRole('heading', {
    name: 'Pending decisions',
    level: 2,
  })).toBeAttached();
  await expect(decisions.getByRole('listitem')).toHaveCount(2);
  for (const name of [
    'Send the customer follow-up?',
    "Update Acme's account owner in HubSpot",
  ]) {
    await expect(decisions.getByRole('heading', {
      name,
      level: 3,
    })).toHaveCount(1);
  }

  const expectedButtons = [
    'Approve: Send the customer follow-up?',
    'Reject: Send the customer follow-up?',
    "Approve: Update Acme's account owner in HubSpot",
    "Reject: Update Acme's account owner in HubSpot",
  ];
  for (const name of expectedButtons) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
  }

  const subject = "Update Acme's account owner in HubSpot";
  for (const name of [
    `Recipe for ${subject}`,
    `Connection for ${subject}`,
    `Recipe run history for ${subject}`,
  ]) {
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(1);
  }

  const handoffHeights = await page.locator('.rx-approval-card-links a')
    .evaluateAll((links) => links.map(
      (link) => link.getBoundingClientRect().height,
    ));
  expect(handoffHeights.length).toBeGreaterThan(0);
  expect(Math.min(...handoffHeights)).toBeGreaterThanOrEqual(36);

  const decisionHeights = await page.locator('.rx-approval-card-actions button')
    .evaluateAll((buttons) => buttons.map(
      (button) => button.getBoundingClientRect().height,
    ));
  expect(decisionHeights.length).toBeGreaterThan(0);
  expect(Math.min(...decisionHeights)).toBeGreaterThanOrEqual(36);
});

test('Approvals contains long decisions through both confirmation states', async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 900 });
  await page.goto(
    `${HARNESS_URL}?attention=destructive&approvals_text=long`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const route = page.locator('[data-recued-approvals-route]');
  const gate = page.locator(
    '[data-recued-approvals-focus="approval-attention-1"]',
  );
  const ask = page.locator(
    '[data-recued-approvals-focus="ask-attention-1"]',
  );
  await expect(gate).toBeVisible();
  await expect(ask).toBeVisible();

  const expectContained = async (): Promise<void> => {
    const measurements = await route.evaluate((root) => ({
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      cards: Array.from(root.querySelectorAll<HTMLElement>('[role="listitem"]'))
        .map((card) => ({
          clientWidth: card.clientWidth,
          scrollWidth: card.scrollWidth,
          right: card.getBoundingClientRect().right,
          widestRight: Math.max(
            card.getBoundingClientRect().right,
            ...Array.from(card.querySelectorAll<HTMLElement>('*'))
              .map((node) => node.getBoundingClientRect().right),
          ),
        })),
    }));
    expect(measurements.scrollWidth).toBeLessThanOrEqual(
      measurements.clientWidth + 1,
    );
    expect(measurements.cards).toHaveLength(2);
    for (const card of measurements.cards) {
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
      expect(card.widestRight).toBeLessThanOrEqual(card.right + 1);
    }
  };

  await expectContained();

  await gate.locator('[data-recued-approval-action="arm"]').click();
  await expect(
    gate.locator('[data-recued-approval-caution]'),
  ).toBeVisible();
  await expect(
    gate.locator('[data-recued-approval-action="confirm"]'),
  ).toBeVisible();
  await expectContained();

  await ask.locator('[data-recued-ask-option="approve"]').click();
  await expect(ask.locator('[data-recued-ask-confirm]')).toBeVisible();
  await expect(
    ask.locator('[data-recued-ask-option="approve"]'),
  ).toHaveAttribute('aria-pressed', 'true');
  await expectContained();
});

test('Approvals moves focus to the next card after resolving a gate', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?attention=pending`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const gate = page.locator(
    '[data-recued-approvals-focus="approval-attention-1"]',
  );
  const ask = page.locator(
    '[data-recued-approvals-focus="ask-attention-1"]',
  );
  await expect(gate).toBeVisible();
  const approve = gate.getByRole('button', {
    name: "Approve: Update Acme's account owner in HubSpot",
    exact: true,
  });
  await approve.focus();
  await page.keyboard.press('Enter');

  await expect(gate).toHaveCount(0);
  await expect(ask).toBeVisible();
  await expect(ask).toHaveAttribute('tabindex', '-1');
  await expect(ask).toBeFocused();
});

test('Approvals keeps a slow gate decision focus-owned and attached', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=pending&attention_action_response=slow&hold_rpc=approval.resolve`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const gate = page.locator(
    '[data-recued-approvals-focus="approval-attention-1"]',
  );
  const ask = page.locator(
    '[data-recued-approvals-focus="ask-attention-1"]',
  );
  const approve = gate.getByRole('button', {
    name: "Approve: Update Acme's account owner in HubSpot",
    exact: true,
  });
  await approve.focus();
  await page.keyboard.press('Enter');

  const approving = gate.getByRole('button', {
    name: "Approving…: Update Acme's account owner in HubSpot",
    exact: true,
  });
  const reject = gate.getByRole('button', {
    name: "Reject: Update Acme's account owner in HubSpot",
    exact: true,
  });
  await expect(approving).toHaveAttribute('aria-disabled', 'true');
  await expect(approving).toHaveAttribute('aria-busy', 'true');
  await expect(approving).not.toHaveAttribute('disabled');
  await expect(approving).toBeFocused();
  await expect(reject).toHaveAttribute('aria-disabled', 'true');
  await expect(reject).not.toHaveAttribute('aria-busy');
  await approving.dispatchEvent('click');
  await approving.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('approval.resolve')),
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
    'Something is still happening here. Leave anyway?',
  );
  await expect(page).toHaveURL(/#approvals$/);
  await expect(approving).toBeFocused();

  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('approval.resolve'))).toBe(1);
  await expect(gate).toHaveCount(0);
  await expect(ask).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Approvals keeps a slow ask answer focus-owned and attached', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=pending&attention_action_response=slow`
    + '&attention_action_delay_ms=2500',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const ask = page.locator(
    '[data-recued-approvals-focus="ask-attention-1"]',
  );
  const gate = page.locator(
    '[data-recued-approvals-focus="approval-attention-1"]',
  );
  const pendingReads = await page.evaluate(
    () => window.__app.rpcCallCount('notification.pending_asks'),
  );
  await ask.getByRole('button', {
    name: 'Approve: Send the customer follow-up?',
    exact: true,
  }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('notification.submitAnswer'),
    ),
  ).toBe(1);

  await page.evaluate(() => window.__app.fireMessage({
    type: 'server_event',
    event: {
      kind: 'notification.ask',
      ask_id: 'ask-attention-live-repaint',
      title: 'Another pending decision',
      text: 'Keep the current answer attached while the queue refreshes.',
      options: [{ id: 'ok', label: 'OK' }],
      cursor: 74,
    },
  }));
  await page.waitForFunction(
    (previous) =>
      window.__app.rpcCallCount('notification.pending_asks') > previous,
    pendingReads,
  );
  const approving = ask.getByRole('button', {
    name: 'Approving…: Send the customer follow-up?',
    exact: true,
  });
  const reject = ask.getByRole('button', {
    name: 'Reject: Send the customer follow-up?',
    exact: true,
  });
  await expect(approving).toHaveAttribute('aria-disabled', 'true');
  await expect(approving).toHaveAttribute('aria-busy', 'true');
  await expect(approving).not.toHaveAttribute('disabled');
  await expect(approving).toBeFocused();
  await expect(reject).toHaveAttribute('aria-disabled', 'true');
  await expect(reject).not.toHaveAttribute('aria-busy');
  await approving.dispatchEvent('click');
  await reject.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('notification.submitAnswer'),
    ),
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
    'Something is still happening here. Leave anyway?',
  );
  await expect(page).toHaveURL(/#approvals$/);
  await expect(approving).toBeFocused();

  await expect(ask).toHaveCount(0);
  await expect(gate).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Approvals keeps a slow Chat plan decision focus-owned and attached', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=plan&attention_action_response=slow`
    + '&attention_action_delay_ms=2500',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const plan = page.locator(
    '[data-recued-approvals-focus="plan-attention-1"]',
  );
  await plan.getByRole('button', {
    name: 'Approve: mail.send',
    exact: true,
  }).focus();
  await page.keyboard.press('Enter');

  const approving = plan.getByRole('button', {
    name: 'Approving…: mail.send',
    exact: true,
  });
  const reject = plan.getByRole('button', {
    name: 'Reject: mail.send',
    exact: true,
  });
  await expect(approving).toHaveAttribute('aria-disabled', 'true');
  await expect(approving).toHaveAttribute('aria-busy', 'true');
  await expect(approving).not.toHaveAttribute('disabled');
  await expect(approving).toBeFocused();
  await expect(reject).toHaveAttribute('aria-disabled', 'true');
  await expect(reject).not.toHaveAttribute('aria-busy');
  await approving.dispatchEvent('click');
  await reject.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('chat.plan.approve')),
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
    'Something is still happening here. Leave anyway?',
  );
  await expect(page).toHaveURL(/#approvals$/);
  await expect(approving).toBeFocused();

  await expect(plan).toHaveCount(0);
  const continuation = page.getByRole('link', {
    name: 'Carry on in Chat',
    exact: true,
  });
  const planReceipt = page.locator('.approvals-plan-resolution');
  const planActions = planReceipt.locator('a, button');
  await expect(continuation).toBeVisible();
  await expect(continuation).toBeFocused();
  await expect(planActions).toHaveCount(2);
  const planActionHeights = await planActions.evaluateAll((actions) =>
    actions.map((action) => action.getBoundingClientRect().height)
  );
  expect(Math.min(...planActionHeights)).toBeGreaterThanOrEqual(36);
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Approvals returns a rejected decision to its exact retry action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=pending&approval_resolve_response=fail`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const gate = page.locator(
    '[data-recued-approvals-focus="approval-attention-1"]',
  );
  const reject = gate.getByRole('button', {
    name: "Reject: Update Acme's account owner in HubSpot",
    exact: true,
  });
  await reject.focus();
  await page.keyboard.press('Enter');

  const error = gate.getByRole('alert');
  await expect(error).toHaveText('The approval decision could not be saved.');
  await expect(reject).toBeEnabled();
  await expect(reject).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('approval.resolve'),
    ),
  ).toBe(2);
});

test('Approvals moves focus to the next card after answering an ask', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?attention=pending`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const ask = page.locator(
    '[data-recued-approvals-focus="ask-attention-1"]',
  );
  const gate = page.locator(
    '[data-recued-approvals-focus="approval-attention-1"]',
  );
  await expect(ask).toBeVisible();
  const approve = ask.getByRole('button', {
    name: 'Approve: Send the customer follow-up?',
    exact: true,
  });
  await approve.focus();
  await page.keyboard.press('Enter');

  await expect(ask).toHaveCount(0);
  await expect(gate).toBeVisible();
  await expect(gate).toHaveAttribute('tabindex', '-1');
  await expect(gate).toBeFocused();
});

test('Approvals keeps an acknowledged ask retired when reconciliation fails', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=pending&ask_answer_response=followup-list-fail`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const ask = page.locator(
    '[data-recued-approvals-focus="ask-attention-1"]',
  );
  const gate = page.locator(
    '[data-recued-approvals-focus="approval-attention-1"]',
  );
  const pendingReadsBefore = await page.evaluate(
    () => window.__app.rpcCallCount('notification.pending_asks'),
  );
  const approve = ask.getByRole('button', {
    name: 'Approve: Send the customer follow-up?',
    exact: true,
  });
  await approve.focus();
  await page.keyboard.press('Enter');

  await expect(ask).toHaveCount(0);
  await expect(gate).toHaveAttribute('tabindex', '-1');
  await expect(gate).toBeFocused();
  const error = page.locator('[data-recued-approvals-error="error"]')
    .filter({ hasText: 'answered ask queue' });
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText(
    'The answered ask queue could not be refreshed.',
  );
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('notification.pending_asks'),
    ),
  ).toBe(pendingReadsBefore + 1);
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('notification.submitAnswer'),
    ),
  ).toBe(1);
});

test('Approvals returns a rejected ask answer to its exact retry option', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=pending&ask_answer_response=fail`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const ask = page.locator(
    '[data-recued-approvals-focus="ask-attention-1"]',
  );
  const reject = ask.getByRole('button', {
    name: 'Reject: Send the customer follow-up?',
    exact: true,
  });
  await reject.focus();
  await page.keyboard.press('Enter');

  await expect(ask.getByRole('alert')).toHaveText(
    'Recued could not send that. Try again.',
  );
  await expect(reject).toBeEnabled();
  await expect(reject).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('notification.submitAnswer'),
    ),
  ).toBe(2);
});

test('Approvals returns a rejected Chat plan to its exact retry action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?attention=plan&plan_resolve_response=fail`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const plan = page.locator(
    '[data-recued-approvals-focus="plan-attention-1"]',
  );
  const approve = plan.getByRole('button', {
    name: 'Approve: mail.send',
    exact: true,
  });
  await approve.focus();
  await page.keyboard.press('Enter');

  await expect(plan.getByRole('alert')).toHaveText(
    'The Chat plan decision could not be saved.',
  );
  await expect(approve).toBeEnabled();
  await expect(approve).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.plan.approve'),
    ),
  ).toBe(2);
});

test('Approvals keeps focus on destructive confirmation controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?attention=destructive`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#approvals'));

  const gate = page.locator(
    '[data-recued-approvals-focus="approval-attention-1"]',
  );
  const approve = gate.getByRole('button', {
    name: "Approve: Update Acme's account owner in HubSpot",
    exact: true,
  });
  await approve.focus();
  await page.keyboard.press('Enter');

  const confirm = gate.getByRole('button', {
    name: "Confirm: Update Acme's account owner in HubSpot",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeFocused();

  const listCalls = await page.evaluate(
    () => window.__app.rpcCallCount('approval.list'),
  );
  await page.evaluate(() => {
    window.__app.fireMessage({
      type: 'server_event',
      event: {
        kind: 'approval',
        subkind: 'pending',
        id: 'approval-attention-1',
        cursor: 21,
      },
    });
  });
  await page.waitForFunction(
    (previous) => window.__app.rpcCallCount('approval.list') > previous,
    listCalls,
  );
  await expect(confirm).toBeFocused();

  const cancel = gate.getByRole('button', {
    name: "Cancel confirmation: Update Acme's account owner in HubSpot",
    exact: true,
  });
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(approve).toBeVisible();
  await expect(approve).toBeFocused();
});
