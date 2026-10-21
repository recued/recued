import { expect, test } from '@playwright/test';
import {
  CHAT_COMPOSER_ACTION, CREATE_OVERLAY, DRAWER_ACTION, DRAWER_OPEN,
  DRAWER_TOGGLE, HARNESS_URL, SHELL_HOST, installFullAppHooks,
} from './helpers/full-app.js';

/** Create browser journeys against the deterministic full-app harness. */
const CREATE_OVERLAY_DISCARD_GUARD =
  'data-recued-create-overlay-discard-guard';
const CREATE_OVERLAY_DISCARD_KEEP =
  'data-recued-create-overlay-discard-keep';
const CREATE_OVERLAY_DISCARD_COMMIT =
  'data-recued-create-overlay-discard-commit';

installFullAppHooks();

test('drawer Create returns focus to the stable navigation toggle', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.locator(`[${DRAWER_TOGGLE}]`);
  await toggle.click();

  const create = page.locator(`[${DRAWER_ACTION}="create"]`);
  await create.focus();
  await page.keyboard.press('Enter');

  const overlay = page.locator(`[${CREATE_OVERLAY}]`);
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole('dialog', { name: 'Create' })).toBeFocused();
  await expect(page.locator(`[${SHELL_HOST}][${DRAWER_OPEN}]`)).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await page.waitForTimeout(250);
  await expect(toggle).toBeFocused();
});

test('Create exposes one dialog heading without the embedded route title', async ({ page }) => {
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_ACTION}="create"]`).click();

  const overlay = page.locator(`[${CREATE_OVERLAY}]`);
  await expect(overlay.getByRole('heading', {
    name: 'Create',
    level: 2,
  })).toBeVisible();
  await expect(overlay.locator('.compose-header')).toBeHidden();
  await expect(overlay.getByRole('heading', { name: 'Compose' })).toHaveCount(0);
});

test('Create keeps every action target usable on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_ACTION}="create"]`).click();

  const overlay = page.locator(`[${CREATE_OVERLAY}]`);
  const actionSizes = await overlay.locator('button:visible').evaluateAll(
    (buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  // ⚠ NAME the actions, don't count them. This pinned `7`, went stale when a
  // sixth capture target shipped, and was replaced by "the chips plus exactly
  // two more (Close and Commit)" — itself a count, which went red when D-325
  // (a576e94be) put an Asset button in the header. Every target chip must be a
  // button, and each other action must be there by name, so one that
  // disappears still fails while one that is added is measured like the rest.
  const chipCount = await overlay.locator('[data-recued-compose-target]:visible').count();
  expect(chipCount).toBeGreaterThanOrEqual(5);
  await expect(overlay.locator('button[data-recued-compose-target]:visible'))
    .toHaveCount(chipCount);
  await expect(overlay.getByRole('button', { name: 'Asset', exact: true })).toBeVisible();
  await expect(overlay.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  await expect(overlay.getByRole('button', { name: /^Commit / })).toBeVisible();
  expect(actionSizes.length).toBeGreaterThanOrEqual(chipCount + 3);
  // THE POINT: at 320px every one of them is still a usable tap target.
  expect(Math.min(...actionSizes.map(({ width }) => width)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.min(...actionSizes.map(({ height }) => height)))
    .toBeGreaterThanOrEqual(36);

  await page.locator('[data-recued-compose-field="email"]')
    .fill('unfinished@example.test');
  await overlay.getByRole('button', { name: 'Close', exact: true }).click();
  const guard = page.locator(`[${CREATE_OVERLAY_DISCARD_GUARD}]`);
  await expect(guard).toBeVisible();
  const guardSizes = await guard.locator('button').evaluateAll(
    (buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  expect(guardSizes).toHaveLength(2);
  expect(Math.min(...guardSizes.map(({ width }) => width)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.min(...guardSizes.map(({ height }) => height)))
    .toBeGreaterThanOrEqual(36);
});

test('Create keeps desktop form fields full-sized', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_ACTION}="create"]`).click();

  const email = page.locator('[data-recued-compose-field="email"]');
  const emailBounds = await email.boundingBox();
  expect(emailBounds?.height).toBeGreaterThanOrEqual(36);

  await page.locator('[data-recued-compose-target="task"]').click();
  const priority = page.locator('[data-recued-compose-field="priority"]');
  const priorityBounds = await priority.boundingBox();
  expect(priorityBounds?.height).toBeGreaterThanOrEqual(36);
});

test('Create fields preserve native keyboard and select focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_ACTION}="create"]`).click();

  await page.locator('[data-recued-compose-target="task"]').click();
  const title = page.locator('[data-recued-compose-field="title"]');
  const body = page.locator('[data-recued-compose-field="body"]');
  await title.fill('Draft launch');
  await title.focus();
  await page.keyboard.press('Tab');
  await expect(body).toBeFocused();

  const priority = page.locator('[data-recued-compose-field="priority"]');
  await priority.focus();
  await priority.selectOption('high');
  await expect(priority).toHaveValue('high');
  await expect(priority).toBeFocused();
});

test('Create preserves unfinished fields across target switches', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_ACTION}="create"]`).click();

  const contact = page.locator('[data-recued-compose-target="contact"]');
  const task = page.locator('[data-recued-compose-target="task"]');
  const email = page.locator('[data-recued-compose-field="email"]');
  const name = page.locator('[data-recued-compose-field="name"]');
  await email.fill('lee@example.test');
  await name.fill('Lee Morgan');

  await contact.click();
  await expect(email).toHaveValue('lee@example.test');
  await expect(name).toHaveValue('Lee Morgan');

  await task.click();
  const title = page.locator('[data-recued-compose-field="title"]');
  const body = page.locator('[data-recued-compose-field="body"]');
  await title.fill('Prepare launch');
  await body.fill('Review the final checklist.');

  await contact.click();
  await expect(email).toHaveValue('lee@example.test');
  await expect(name).toHaveValue('Lee Morgan');

  await task.click();
  await expect(title).toHaveValue('Prepare launch');
  await expect(body).toHaveValue('Review the final checklist.');
});

test('Create protects unfinished capture from dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_ACTION}="create"]`).click();

  const overlay = page.locator(`[${CREATE_OVERLAY}]`);
  const email = page.locator('[data-recued-compose-field="email"]');
  const name = page.locator('[data-recued-compose-field="name"]');
  const close = overlay.getByRole('button', { name: 'Close', exact: true });
  const guard = page.locator(`[${CREATE_OVERLAY_DISCARD_GUARD}]`);
  await email.fill('unfinished@example.test');
  await name.fill('企画担当');
  await name.focus();
  const composingEscape = await name.evaluate((input) => {
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
  await expect(guard).toHaveCount(0);
  await expect(name).toHaveValue('企画担当');
  await expect(name).toBeFocused();

  await page.locator('[data-recued-compose-target="task"]').click();
  await close.focus();
  await page.keyboard.press('Enter');

  await expect(overlay).toBeVisible();
  await expect(guard).toHaveAttribute('role', 'alertdialog');
  await expect(guard).toBeFocused();
  await expect(guard).toContainText('Throw this away?');

  await page.keyboard.press('Escape');
  await expect(guard).toHaveCount(0);
  await expect(close).toBeFocused();
  await page.locator('[data-recued-compose-target="contact"]').click();
  await expect(email).toHaveValue('unfinished@example.test');

  await close.focus();
  await page.keyboard.press('Enter');
  await expect(guard).toBeFocused();
  await page.locator(`[${CREATE_OVERLAY_DISCARD_KEEP}]`).click();
  await expect(guard).toHaveCount(0);
  await expect(close).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(guard).toBeFocused();
  const discard = page.locator(`[${CREATE_OVERLAY_DISCARD_COMMIT}]`);
  await expect(discard).toHaveText('Throw it away');
  await discard.click();
  await expect(overlay).toHaveCount(0);
});

test('Create exposes its selected target as a named toggle group', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_ACTION}="create"]`).click();

  const types = page.getByRole('group', { name: 'Create type' });
  const contact = types.getByRole('button', { name: 'Contact' });
  const task = types.getByRole('button', { name: 'Task' });
  await expect(contact).toHaveAttribute('aria-pressed', 'true');
  await expect(task).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('textbox', { name: 'Email' }))
    .toHaveAttribute('aria-required', 'true');
  await expect(page.getByRole('textbox', { name: 'Name' }))
    .not.toHaveAttribute('aria-required');

  await task.click();

  await expect(contact).toHaveAttribute('aria-pressed', 'false');
  await expect(task).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: 'Title' }))
    .toHaveAttribute('aria-required', 'true');
  await expect(page.getByRole('textbox', { name: 'Body' }))
    .not.toHaveAttribute('aria-required');
});

test('Create Commit retains action focus through confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?compose_commit_response=slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_ACTION}="create"]`).click();

  await page.locator('[data-recued-compose-field="email"]')
    .fill('lee@example.test');
  await page.locator('[data-recued-compose-field="name"]')
    .fill('Lee Morgan');
  const commit = page.locator('[data-recued-compose-commit]');
  const initialCommit = await commit.elementHandle();
  await commit.focus();
  await page.keyboard.press('Enter');

  await expect(commit).toHaveText('Committing…');
  await expect(commit).toBeFocused();
  await expect(commit).not.toHaveAttribute('disabled');
  await expect(commit).toHaveAttribute('aria-disabled', 'true');
  await expect(commit).toHaveAttribute('aria-busy', 'true');
  const overlay = page.locator(`[${CREATE_OVERLAY}]`);
  const close = overlay.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toHaveAttribute('aria-disabled', 'true');
  await expect(close).not.toHaveAttribute('disabled');
  await page.keyboard.press('Escape');
  await expect(overlay).toBeVisible();
  await close.dispatchEvent('click');
  await close.dispatchEvent('click');
  await expect(overlay).toBeVisible();
  await overlay.dispatchEvent('click');
  await expect(overlay).toBeVisible();
  await initialCommit?.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(async () => page.evaluate(() =>
    window.__app.rpcCallCount('contact.upsert'))).toBe(1);
  const confirmation = page.locator('[data-recued-compose-confirmation]');
  await expect(confirmation).toContainText('Committed Contact');
  await expect(confirmation).toContainText('Lee Morgan');
  await expect(page.locator('[data-recued-compose-field="email"]')).toHaveValue('');
  await expect(close).not.toHaveAttribute('aria-disabled');
  await expect(commit).toBeFocused();
  await close.click();
  await expect(overlay).toHaveCount(0);
});

test('Chat Create retains an unfinished item across tab and route leave', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?chat=session#chat/session/chat_1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${CHAT_COMPOSER_ACTION}="create"]`).click();

  const overlay = page.locator(`[${CREATE_OVERLAY}]`);
  const email = page.locator('[data-recued-compose-field="email"]');
  await email.fill('unfinished@example.test');
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return window.dispatchEvent(event);
  })).toBe(false);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    window.__app.setHash('#data');
  });

  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Throw away this unfinished item?',
  );
  await expect.poll(() => page.evaluate(() => window.location.hash))
    .toBe('#chat/session/chat_1');
  await expect(overlay).toBeVisible();
  await expect(email).toHaveValue('unfinished@example.test');

  await page.evaluate(() => {
    window.confirm = () => true;
    window.__app.setHash('#data');
  });
  await expect(page).toHaveURL(/#data$/);
  await expect(overlay).toHaveCount(0);
});

test('Chat Create retains an unresolved save across tab and route leave', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?chat=session&compose_commit_response=slow`
    + '#chat/session/chat_1',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator(`[${CHAT_COMPOSER_ACTION}="create"]`).click();

  await page.locator('[data-recued-compose-field="email"]')
    .fill('lee@example.test');
  await page.locator('[data-recued-compose-field="name"]')
    .fill('Lee Morgan');
  const commit = page.locator('[data-recued-compose-commit]');
  await commit.click();
  await expect(commit).toHaveText('Committing…');
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return window.dispatchEvent(event);
  })).toBe(false);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = (message?: string): boolean => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      root.setAttribute('data-audit-confirm-message', message ?? '');
      return false;
    };
    window.__app.setHash('#data');
  });

  const html = page.locator('html');
  const overlay = page.locator(`[${CREATE_OVERLAY}]`);
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Recued is still saving. Leave anyway?',
  );
  await expect.poll(() => page.evaluate(() => window.location.hash))
    .toBe('#chat/session/chat_1');
  await expect(overlay).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('contact.upsert'))).toBe(1);

  await expect(page.locator('[data-recued-compose-confirmation]'))
    .toContainText('Committed Contact');
  await page.evaluate(() => window.__app.setHash('#data'));
  await expect(page).toHaveURL(/#data$/);
  await expect(overlay).toHaveCount(0);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('drawer Create guards tab unload while staying open across routes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`[${DRAWER_TOGGLE}]`).click();
  await page.locator(`[${DRAWER_ACTION}="create"]`).click();

  const overlay = page.locator(`[${CREATE_OVERLAY}]`);
  const email = page.locator('[data-recued-compose-field="email"]');
  await email.fill('drawer@example.test');
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return window.dispatchEvent(event);
  })).toBe(false);

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-audit-confirm-count', '0');
    window.confirm = () => {
      const root = document.documentElement;
      const count = Number(root.getAttribute('data-audit-confirm-count') ?? '0');
      root.setAttribute('data-audit-confirm-count', String(count + 1));
      return false;
    };
    window.__app.setHash('#data');
  });
  await expect(page).toHaveURL(/#data$/);
  await expect(overlay).toBeVisible();
  await expect(email).toHaveValue('drawer@example.test');
  await expect(page.locator('html')).toHaveAttribute(
    'data-audit-confirm-count',
    '0',
  );
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    return window.dispatchEvent(event);
  })).toBe(false);
});

test('every Create target COMPLETES a commit and the confirmation names it', async ({ page }) => {
  // ⛔⛔ THE GAP THIS FILLS. The shipped Create commit test drives the CONTACT
  // target and asserts only the PENDING state before escaping — it never
  // completes a commit. So when `work_entity.upsert` went unanswered in this
  // harness, all five work-entity captures sat on "Saving…" forever
  // and nothing reported it: a whole confirmation path was untested here while
  // 6,363 unit tests stayed green.
  const targets: ReadonlyArray<[string, Record<string, string>, string]> = [
    ['task', { title: 'Ship the thing' }, 'Ship the thing'],
    ['note', { body: 'A thought worth keeping' }, 'A thought worth keeping'],
    ['commitment', { statement: 'Send Maya the draft' }, 'Send Maya the draft'],
    ['project', { title: 'Q4 rollout' }, 'Q4 rollout'],
    ['booking', {
      title: 'Haircut',
      slot_start_at: '2026-09-14T10:00',
      slot_end_at: '2026-09-14T11:00',
    }, 'Haircut'],
  ];

  for (const [target, fields, label] of targets) {
    await page.goto(HARNESS_URL);
    await page.waitForFunction(() => window.__app?.ready === true);
    await page.locator(`[${DRAWER_TOGGLE}]`).click();
    await page.locator(`[${DRAWER_ACTION}="create"]`).click();
    await page.locator(`[data-recued-compose-target="${target}"]`).click();
    for (const [key, value] of Object.entries(fields)) {
      await page.locator(`[data-recued-compose-field="${key}"]`).fill(value);
    }
    await page.locator('[data-recued-compose-commit]').click();

    // ⚠ Asserts the LABEL, not merely that a confirmation appeared: the
    // overlay reads it off the returned row, so a commit that succeeded while
    // losing what was captured would still show a confirmation.
    const confirmation = page.locator('[data-recued-compose-confirmation]');
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText(label);
    await expect(page.locator('[data-recued-create-overlay]')).not.toContainText('Committing');
  }
});
