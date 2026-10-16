import { expect, test } from '@playwright/test';
import {
  HARNESS_URL, LIST_PREVIEW, SETTINGS_NAV_ITEM, SHARED_REFERENCE, SHARED_REFERENCE_ID,
  installFullAppHooks,
} from './helpers/full-app.js';

/** Settings browser journeys against the deterministic full-app harness. */
const SETTINGS_NAV = 'data-recued-settings-nav';
const SETTINGS_SUBTAB = 'data-recued-settings-subtab';
const EXPOSURE_CELL = 'data-recued-exposure-cell';
const EXPOSURE_PUBLIC_MCP = 'data-recued-exposure-public-mcp';
const EXPOSURE_MODAL_CANCEL = 'data-recued-exposure-modal-cancel';
const EXPOSURE_MODAL_SUBMIT = 'data-recued-exposure-modal-submit';
const CLEAR_THIS_BROWSER_CLEAR = 'data-recued-clear-this-browser-clear';
const CLEAR_THIS_BROWSER_CONFIRM = 'data-recued-clear-this-browser-confirm';
const CLEAR_THIS_BROWSER_CANCEL = 'data-recued-clear-this-browser-cancel';
const CLEAR_THIS_BROWSER_RETRY = 'data-recued-clear-this-browser-retry';
const CLEAR_THIS_BROWSER_RELOAD = 'data-recued-clear-this-browser-reload';
const CLEAR_THIS_BROWSER_STATUS = 'data-recued-clear-this-browser-status';
const ARCHIVE_BACKUP_START = 'data-recued-archive-backup-start';
const ARCHIVE_RESTORE_START = 'data-recued-archive-restore-start';
const ARCHIVE_BACKUP_MNEMONIC = 'data-recued-archive-backup-mnemonic';
const ARCHIVE_BACKUP_RUN = 'data-recued-archive-backup-run';
const ARCHIVE_BACKUP_PROGRESS = 'data-recued-archive-backup-progress';
const ARCHIVE_RESTORE_UPLOAD_INPUT = 'data-recued-archive-restore-upload';
const ARCHIVE_RESTORE_PATH = 'data-recued-archive-restore-path';
const ARCHIVE_RESTORE_MNEMONIC = 'data-recued-archive-restore-mnemonic';
const ARCHIVE_RESTORE_PREVIEW = 'data-recued-archive-restore-preview';
const ARCHIVE_RESTORE_ARM = 'data-recued-archive-restore-arm';
const ARCHIVE_RESTORE_COMMIT = 'data-recued-archive-restore-commit';
const ARCHIVE_PASSPORT_START = 'data-recued-archive-passport-start';
const ARCHIVE_BACKUP_BUSY = 'data-recued-archive-backup-busy';
const ARCHIVE_BACKUP_CANCEL = 'data-recued-archive-backup-cancel';
const TRANSPARENCY_TOGGLE = 'data-recued-transparency-toggle';
const LEARNING_TOGGLE = 'data-recued-learning-toggle';
const LEARNING_CASE = 'data-recued-learning-case';
const LEARNING_CASES_EMPTY = 'data-recued-learning-cases-empty';
const LEARNING_CASES_ERROR = 'data-recued-learning-cases-error';
const LEARNING_DRAFT = 'data-recued-learning-draft';
const LEARNING_DRAFT_CONFIRM = 'data-recued-learning-draft-confirm';
const LEARNING_DRAFT_ERROR = 'data-recued-learning-draft-error';
const LEARNING_DRAFT_PROMPT = 'data-recued-learning-draft-prompt';
const LEARNING_DRAFT_ROUTE = 'data-recued-execution-case-draft';
const LEARNING_FORGET = 'data-recued-learning-forget';
const LEARNING_FORGET_ERROR = 'data-recued-learning-forget-error';
const UPDATES_CHECK = 'data-recued-updates-check';
const UPDATES_STATUS = 'data-recued-updates-status';
const UPDATES_ERROR = 'data-recued-updates-error';
const UPDATES_APPLY = 'data-recued-updates-apply';
const UPDATES_ROLLBACK = 'data-recued-updates-rollback';
const UPDATES_MODE = 'data-recued-updates-mode';

installFullAppHooks();

test('Settings Backup & Recovery hands focus into and back from each entry flow', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/backup'));

  const backupSection = page.locator(
    '[data-recued-settings-section="backup"]',
  );
  await expect(backupSection.getByRole('heading', {
    name: 'Backup & Recovery',
    exact: true,
  })).toHaveCount(1);

  const backup = page.locator(`[${ARCHIVE_BACKUP_START}]`);
  await backup.focus();
  await page.keyboard.press('Enter');
  const backupKey = page.getByRole('textbox', {
    name: '24-word recovery key',
  });
  await expect(backupKey).toHaveAttribute(ARCHIVE_BACKUP_MNEMONIC, '');
  await expect(backupKey).toBeFocused();

  let cancel = page.locator(`[${ARCHIVE_BACKUP_CANCEL}]`);
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(backup).toBeFocused();

  const restore = page.locator(`[${ARCHIVE_RESTORE_START}]`);
  await restore.focus();
  await page.keyboard.press('Enter');
  const restoreEntry = page.locator(
    `[${ARCHIVE_RESTORE_UPLOAD_INPUT}], [${ARCHIVE_RESTORE_PATH}]`,
  ).first();
  await expect(restoreEntry).toBeFocused();
  await expect(page.getByLabel('Upload a backup file from this device'))
    .toHaveAttribute(ARCHIVE_RESTORE_UPLOAD_INPUT, '');
  await expect(page.getByRole('textbox', {
    name: 'Or where to find one already on your server',
  })).toHaveAttribute(ARCHIVE_RESTORE_PATH, '');
  await expect(page.getByRole('textbox', {
    name: 'Recovery key for this backup',
  })).toHaveAttribute(ARCHIVE_RESTORE_MNEMONIC, '');

  cancel = page.locator(`[${ARCHIVE_BACKUP_CANCEL}]`);
  await cancel.focus();
  await page.keyboard.press('Enter');
  await expect(restore).toBeFocused();
});

test('Settings Backup keeps a keyboard-owned export on its live progress', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
  await page.locator(`[${ARCHIVE_BACKUP_START}]`).click();
  await page.locator(`[${ARCHIVE_BACKUP_MNEMONIC}]`).fill(
    `${'abandon '.repeat(23)}art`,
  );

  const run = page.locator(`[${ARCHIVE_BACKUP_RUN}]`);
  await run.focus();
  await page.keyboard.press('Enter');

  const progress = page.locator(`[${ARCHIVE_BACKUP_PROGRESS}]`);
  await expect(progress).toHaveAttribute('role', 'progressbar');
  await expect(progress).toHaveAttribute('tabindex', '-1');
  await expect(progress).toBeFocused();
});

test('Settings Restore keeps a keyboard-owned preview on its busy status', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
  await page.locator(`[${ARCHIVE_RESTORE_START}]`).click();
  await page.locator(`[${ARCHIVE_RESTORE_PATH}]`).fill(
    'exports/recued-2026-06-25.recued.archive',
  );
  await page.locator(`[${ARCHIVE_RESTORE_MNEMONIC}]`).fill(
    `${'abandon '.repeat(23)}art`,
  );

  const preview = page.locator(`[${ARCHIVE_RESTORE_PREVIEW}]`);
  await preview.focus();
  await page.keyboard.press('Enter');

  const busy = page.locator(`[${ARCHIVE_BACKUP_BUSY}]`);
  await expect(busy).toHaveText('Reading the backup…');
  await expect(busy).toHaveAttribute('tabindex', '-1');
  await expect(busy).toBeFocused();
});

test('Settings Restore keeps its destructive arm focused through confirmation', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?archive=restore-preview`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
  await page.locator(`[${ARCHIVE_RESTORE_START}]`).click();
  await page.locator(`[${ARCHIVE_RESTORE_PATH}]`).fill(
    'exports/recued-2026-06-25.recued.archive',
  );
  await page.locator(`[${ARCHIVE_RESTORE_MNEMONIC}]`).fill(
    `${'abandon '.repeat(23)}art`,
  );
  await page.locator(`[${ARCHIVE_RESTORE_PREVIEW}]`).click();

  const arm = page.locator(`[${ARCHIVE_RESTORE_ARM}]`);
  await expect(arm).toBeVisible();
  await arm.focus();
  await page.keyboard.press('Space');

  await expect(arm).toBeChecked();
  await expect(arm).toBeFocused();
});

test('Settings Restore keeps a keyboard-owned commit on truthful live status', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?archive=restore-preview`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/backup'));
  await page.locator(`[${ARCHIVE_RESTORE_START}]`).click();
  await page.locator(`[${ARCHIVE_RESTORE_PATH}]`).fill(
    'exports/recued-2026-06-25.recued.archive',
  );
  await page.locator(`[${ARCHIVE_RESTORE_MNEMONIC}]`).fill(
    `${'abandon '.repeat(23)}art`,
  );
  await page.locator(`[${ARCHIVE_RESTORE_PREVIEW}]`).click();
  await page.locator(`[${ARCHIVE_RESTORE_ARM}]`).check();

  const commit = page.locator(`[${ARCHIVE_RESTORE_COMMIT}]`);
  await commit.focus();
  await page.keyboard.press('Enter');

  const busy = page.locator(`[${ARCHIVE_BACKUP_BUSY}]`);
  await expect(busy).toHaveText('Putting the backup back…');
  await expect(busy).toHaveAttribute('tabindex', '-1');
  await expect(busy).toBeFocused();
});

test('Settings Passport keeps its keyboard-owned export on live status', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/backup'));

  const start = page.locator(`[${ARCHIVE_PASSPORT_START}]`);
  await start.focus();
  await page.keyboard.press('Enter');

  const busy = page.locator(`[${ARCHIVE_BACKUP_BUSY}]`);
  await expect(busy).toHaveText('Saving this server’s identity…');
  await expect(busy).toHaveAttribute('tabindex', '-1');
  await expect(busy).toBeFocused();
});

test('Settings Transparency retains its pending preference on route leave', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const toggle = page.locator(
    `[${TRANSPARENCY_TOGGLE}="ui.transparency.class.orchestration"]`,
  );
  await expect(toggle).not.toBeChecked();
  const writesBefore = await page.evaluate(
    () => window.__app.rpcCallCount('prefs.set'),
  );
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

  await toggle.focus();
  await page.keyboard.press('Space');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('prefs.set')),
  ).toBe(writesBefore + 1);
  await page.evaluate(() => window.__app.setHash('#chat'));

  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A transparency setting is still updating. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/privacy$/);
  await expect(toggle).toBeChecked();
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).not.toHaveAttribute('disabled');
  await expect(toggle).toBeFocused();
  await toggle.evaluate((checkbox: HTMLElement) => {
    checkbox.click();
    checkbox.click();
  });
  await expect(toggle).toBeChecked();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('prefs.set')),
  ).toBe(writesBefore + 1);
});

test('Settings Privacy gives every mobile checkbox a full label target', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?privacy=learning-cases-multiple`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const section = page.locator('[data-recued-settings-section="privacy"]');
  const targets = section.locator('label:has(input[type="checkbox"])');
  const heights = await targets.evaluateAll((labels) => labels.map(
    (label) => label.getBoundingClientRect().height,
  ));
  expect(heights.length).toBeGreaterThan(0);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(36);
  expect(await section.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  )).toBe(true);
});

test('Settings Learning keeps its pending preference truthful, focused, and single-flight', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const toggle = page.locator(`[${LEARNING_TOGGLE}]`);
  const initiallyChecked = await toggle.isChecked();
  const writesBefore = await page.evaluate(
    () => window.__app.rpcCallCount('prefs.set'),
  );

  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked({ checked: !initiallyChecked });
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).not.toHaveAttribute('disabled');
  await expect(toggle).toBeFocused();

  await toggle.evaluate((checkbox: HTMLElement) => {
    checkbox.click();
    checkbox.click();
  });
  await expect(toggle).toBeChecked({ checked: !initiallyChecked });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('prefs.set')),
  ).toBe(writesBefore + 1);
});

test('Settings Learning identifies repeated case actions by their owning case', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?privacy=learning-cases-multiple`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const firstDraft = page.locator(`[${LEARNING_DRAFT}="learning-case-1"]`);
  const secondDraft = page.locator(`[${LEARNING_DRAFT}="learning-case-2"]`);
  await expect(firstDraft).toHaveAccessibleName(
    'Make a Recipe from what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(secondDraft).toHaveAccessibleName(
    'Make a Recipe from what it learned: schedule the weekly inventory digest (learning-case-2)',
  );
  await expect(page.locator(`[${LEARNING_FORGET}="learning-case-1"]`))
    .toHaveAccessibleName(
      'Forget what it learned: send the quarterly report (learning-case-1)',
    );
  await expect(page.locator(`[${LEARNING_FORGET}="learning-case-2"]`))
    .toHaveAccessibleName(
      'Forget what it learned: schedule the weekly inventory digest (learning-case-2)',
    );
  const actionHeights = await page
    .locator(`[${LEARNING_DRAFT}], [${LEARNING_FORGET}]`)
    .evaluateAll((actions) =>
      actions.map((action) => action.getBoundingClientRect().height)
    );
  expect(Math.min(...actionHeights)).toBeGreaterThanOrEqual(36);
});

test('Settings Learning owns a keyboard Forget through confirmation and removal', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?privacy=learning-cases&learning_forget_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const forget = page.locator(`[${LEARNING_FORGET}="learning-case-1"]`);
  await expect(forget).toHaveText('Forget');
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
  await forget.focus();
  await page.keyboard.press('Enter');

  await expect(forget).toHaveText('Tap again to forget');
  await expect(forget).toHaveAccessibleName(
    'Confirm forgetting what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(forget).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(forget).toHaveText('Forgetting...');
  await expect(forget).toHaveAccessibleName(
    'Forgetting what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(forget).toHaveAttribute('aria-disabled', 'true');
  await expect(forget).toHaveAttribute('aria-busy', 'true');
  await expect(forget).not.toHaveAttribute('disabled');
  await expect(forget).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A learning change is still updating. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/privacy$/);
  const competingDraft = page.locator(
    `[${LEARNING_DRAFT}="learning-case-1"]`,
  );
  await expect(competingDraft).toHaveAttribute('aria-disabled', 'true');
  await expect(competingDraft).not.toHaveAttribute('disabled');
  await competingDraft.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.draft_recipe'),
    ),
  ).toBe(0);
  await forget.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.forget'),
    ),
  ).toBe(1);

  const empty = page.locator(`[${LEARNING_CASES_EMPTY}]`);
  await expect(empty).toBeVisible();
  await expect(empty).toHaveAttribute('tabindex', '-1');
  await expect(empty).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings Learning keeps a failed Forget beside its focused case', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?privacy=learning-cases&learning_forget_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const forget = page.locator(`[${LEARNING_FORGET}="learning-case-1"]`);
  await forget.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(forget).toHaveText('Forgetting...');

  await expect(page.locator(`[${LEARNING_FORGET_ERROR}]`)).toContainText(
    'Learning history is temporarily unavailable.',
  );
  await expect(page.locator(`[${LEARNING_CASE}="learning-case-1"]`))
    .toBeVisible();
  await expect(page.locator(`[${LEARNING_CASES_ERROR}]`)).toHaveCount(0);
  await expect(forget).toHaveText('Tap again to forget');
  await expect(forget).toHaveAccessibleName(
    'Confirm forgetting what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(forget).toBeFocused();
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.forget'),
    ),
  ).toBe(1);
});

test('Settings Learning retains a keyboard-owned recipe draft through failure', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?privacy=learning-cases&learning_draft_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const draft = page.locator(`[${LEARNING_DRAFT}="learning-case-1"]`);
  await draft.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`[${LEARNING_DRAFT_CONFIRM}]`)).toBeVisible();
  await expect(draft).toHaveText('Yes, write the draft');
  await expect(draft).toHaveAccessibleName(
    'Say yes to the Recipe from what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(draft).toBeFocused();

  const prompt = page.locator(`[${LEARNING_DRAFT_PROMPT}]`);
  await expect(prompt).toHaveAccessibleName(
    'What the Recipe should do, for what it learned: send the quarterly report (learning-case-1)',
  );
  await prompt.fill('Run it every Monday');
  await draft.focus();
  await page.keyboard.press('Enter');

  await expect(draft).toHaveText('Asking your AI…');
  await expect(draft).toHaveAccessibleName(
    'Asking your AI to write a Recipe from what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(draft).toHaveAttribute('aria-disabled', 'true');
  await expect(draft).toHaveAttribute('aria-busy', 'true');
  await expect(draft).not.toHaveAttribute('disabled');
  await expect(draft).toBeFocused();
  await expect(prompt).toHaveValue('Run it every Monday');
  const competingForget = page.locator(
    `[${LEARNING_FORGET}="learning-case-1"]`,
  );
  await expect(competingForget).toHaveAttribute('aria-disabled', 'true');
  await expect(competingForget).not.toHaveAttribute('disabled');
  await competingForget.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.forget'),
    ),
  ).toBe(0);
  await draft.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.draft_recipe'),
    ),
  ).toBe(1);

  await expect(page.locator(`[${LEARNING_DRAFT_ERROR}]`)).toContainText(
    'Recipe drafting is temporarily unavailable.',
  );
  await expect(draft).toHaveText('Yes, write the draft');
  await expect(draft).toHaveAccessibleName(
    'Say yes to the Recipe from what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(draft).toBeFocused();
  await expect(prompt).toHaveValue('Run it every Monday');
});

test('Settings Learning retries a finished draft handoff without asking AI again', async ({ page }) => {
  await page.goto(
    `${HARNESS_URL}?privacy=learning-cases&learning_draft_handoff=fail-once`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const draft = page.locator(`[${LEARNING_DRAFT}="learning-case-1"]`);
  await draft.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  await expect(page.locator(`[${LEARNING_DRAFT_ERROR}]`)).toContainText(
    'finished draft',
  );
  await expect(draft).toHaveText('Open finished draft');
  await expect(draft).toHaveAccessibleName(
    'Open finished draft from what it learned: send the quarterly report (learning-case-1)',
  );
  await expect(draft).toBeFocused();
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.draft_recipe'),
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
    'Discard the finished recipe draft?',
  );
  await expect(page).toHaveURL(/#settings\/privacy$/);

  await page.keyboard.press('Enter');
  await expect(page.locator(`[${LEARNING_DRAFT_ROUTE}]`)).toBeVisible();
  await expect.poll(
    () => page.evaluate(
      () => window.__app.rpcCallCount('chat.execution.draft_recipe'),
    ),
  ).toBe(1);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings Privacy owns the Clear-this-browser safety confirmation', async ({ page }) => {
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const clear = page.locator(`[${CLEAR_THIS_BROWSER_CLEAR}]`);
  await clear.focus();
  await page.keyboard.press('Enter');

  const cancel = page.locator(`[${CLEAR_THIS_BROWSER_CANCEL}]`);
  await expect(page.locator(`[${CLEAR_THIS_BROWSER_CONFIRM}]`)).toBeVisible();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(clear).toBeVisible();
  await expect(clear).toBeFocused();
});

test('Settings Privacy owns browser clearing through live completion', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?browser_clear=slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  await page.locator(`[${CLEAR_THIS_BROWSER_CLEAR}]`).click();
  const confirm = page.locator(`[${CLEAR_THIS_BROWSER_CONFIRM}]`);
  await confirm.focus();
  await page.keyboard.press('Enter');

  const status = page.locator(`[${CLEAR_THIS_BROWSER_STATUS}]`);
  await expect(status).toHaveText('Clearing…');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveAttribute('tabindex', '-1');
  await expect(status).toBeFocused();

  await expect(status).toContainText('Load the page again to pair');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toBeFocused();
  await expect(page.locator(`[${CLEAR_THIS_BROWSER_RELOAD}]`)).toBeVisible();
});

test('Settings Privacy retains keyboard ownership through browser-clear recovery', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?browser_clear=fail-slow`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/privacy'));

  const clear = page.locator(`[${CLEAR_THIS_BROWSER_CLEAR}]`);
  await clear.focus();
  await page.keyboard.press('Enter');
  const confirm = page.locator(`[${CLEAR_THIS_BROWSER_CONFIRM}]`);
  await confirm.focus();
  await page.keyboard.press('Enter');

  const status = page.locator(`[${CLEAR_THIS_BROWSER_STATUS}]`);
  await expect(status).toHaveText('Clearing…');
  await expect(status).toBeFocused();
  await expect(status).toContainText(
    'Browser key storage is temporarily unavailable.',
  );
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(status).toHaveAttribute('tabindex', '-1');
  await expect(status).toBeFocused();

  const retry = page.locator(`[${CLEAR_THIS_BROWSER_RETRY}]`);
  await retry.focus();
  await page.keyboard.press('Enter');
  const cancel = page.locator(`[${CLEAR_THIS_BROWSER_CANCEL}]`);
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(clear).toBeFocused();
});

const settingsNavItemIsVisible = (item: HTMLElement, navAttr: string): boolean => {
  const rail = item.closest<HTMLElement>(`[${navAttr}]`);
  if (rail === null) return false;
  const railRect = rail.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const left = railRect.left + rail.clientLeft;
  // Scroll alignment can finish on a fractional CSS pixel at the strip edge.
  return itemRect.left >= left - 1 && itemRect.right <= left + rail.clientWidth + 1;
};

test('Settings reveals the active section in its mobile overflow rail', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(() => window.__app.setHash('#settings/server'));

  const nav = page.locator(`[${SETTINGS_NAV}]`);
  const server = page.locator(`[${SETTINGS_NAV_ITEM}="server"]`);
  const targetHeights = await nav.locator('button').evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().height)
  );
  expect(Math.min(...targetHeights)).toBeGreaterThanOrEqual(36);
  await expect(server).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => server.evaluate(settingsNavItemIsVisible, SETTINGS_NAV)).toBe(true);
  expect(await nav.evaluate((rail) => rail.scrollLeft)).toBeGreaterThan(0);
});

for (const width of [280, 390, 720]) {
  test(`Settings fully reveals keyboard-focused rail items at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.__app.setHash('#settings/account'));
    const items = page.locator(`[${SETTINGS_NAV_ITEM}]`);
    await expect(items.first()).toBeVisible();
    const count = await items.count();
    // Use WebKit's full keyboard navigation shortcut for ordinary buttons.
    const next = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    const previous = browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab';
    await items.first().focus();
    await page.keyboard.press(previous);
    await page.keyboard.press(next);
    for (let index = 0; index < count; index++) {
      const item = items.nth(index);
      await expect(item).toBeFocused();
      await expect.poll(() => item.evaluate(settingsNavItemIsVisible, SETTINGS_NAV)).toBe(true);
      if (index < count - 1) await page.keyboard.press(next);
    }
    await expect(page).toHaveURL(/#settings\/account$/);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#settings\/server$/);
    await expect(items.last()).toBeFocused();
    for (let index = count - 2; index >= 0; index--) {
      await page.keyboard.press(previous);
      const item = items.nth(index);
      await expect(item).toBeFocused();
      await expect.poll(() => item.evaluate(settingsNavItemIsVisible, SETTINGS_NAV)).toBe(true);
    }
  });
}

test('Settings preserves navigation visibility and focus through resizing', async ({ page }) => {
  await page.setViewportSize({ width: 721, height: 900 });
  await page.evaluate(() => window.__app.setHash('#settings/account'));
  const server = page.locator(`[${SETTINGS_NAV_ITEM}="server"]`);
  await server.focus();
  for (const width of [720, 390, 280, 721]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(server).toBeFocused();
    await expect.poll(() => server.evaluate(settingsNavItemIsVisible, SETTINGS_NAV)).toBe(true);
  }
  await expect(page).toHaveURL(/#settings\/account$/);

  await page.goto(`${HARNESS_URL}?settle_reads=1#settings/server`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const section = page.locator('[data-recued-settings-section="server"]');
  await section.focus();
  for (const width of [720, 390, 280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(section).toBeFocused();
    await expect.poll(() => server.evaluate(settingsNavItemIsVisible, SETTINGS_NAV)).toBe(true);
  }
  await section.evaluate((owner) => owner.scrollIntoView({ block: 'start' }));
  const verticalScroll = () => page.evaluate(() => ({
    window: window.scrollY,
    content: document.querySelector('[data-recued-webclient-content]')?.scrollTop,
  }));
  const before = await verticalScroll();
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  expect(await verticalScroll()).toEqual(before);
  await expect(section).toBeFocused();
});

test('Settings omits retired Work Entities controls and recovers their old link', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?work_entities=multiple-sources&settle_reads=1#settings/work-entities`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  // D-187 retired source defaults and muting. Old links use the Settings fallback.
  await expect(page.getByRole('heading', { name: 'Account', level: 2 }))
    .toBeVisible();
  await expect(page.locator(`[${SETTINGS_NAV_ITEM}="account"]`))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.locator(`[${SETTINGS_NAV_ITEM}="work-entities"]`))
    .toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Work Entities' }))
    .toHaveCount(0);
  await expect(page.locator(
    '[data-action="set-source-enabled"], '
      + '[data-action="set-source-mcp-exposed"], '
      + '[data-action="set-default-source"]',
  )).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('work_entity.source.list')))
    .toBe(0);

  await page.locator(`[${SETTINGS_NAV_ITEM}="privacy"]`).click();
  await expect(page.getByRole('heading', { name: 'Privacy', level: 2 }))
    .toBeVisible();
  await expect(page).toHaveURL(/#settings\/privacy$/);
  await expect(page.locator('html')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('html').evaluate((element) => element.clientWidth),
  );
});

test('Settings Seller directory does not repeat its page heading', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/seller'));

  await expect(page.getByRole('heading', {
    name: 'Seller tools',
    exact: true,
  })).toBeVisible();
  await expect(page.getByRole('heading', {
    name: 'Seller',
    exact: true,
  })).toHaveCount(1);
});

test('Settings Seller previews a row before Enter opens its detail', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?settle_reads=1#settings/seller/customers`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const link = page.locator(
    '[data-recued-seller-collection-item-link="customer-1"]',
  );
  await expect(link).toBeVisible();
  await link.click();

  const preview = page.locator(`[${LIST_PREVIEW}]`);
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'customer-shared' }))
    .toBeVisible();
  await expect(page).toHaveURL(/#settings\/seller\/customers$/);
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(link).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(
    /#settings\/seller\/customers\/detail\/customer-1$/,
  );
  await expect(page.locator(
    '[data-recued-seller-collection-detail="customer-1"]',
  )).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#settings\/seller\/customers$/);
  await expect(link).toBeFocused();
});

test('Settings Seller keeps mobile navigation and disclosures full-size', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  for (const hash of [
    '#settings/seller/orders',
    '#settings/seller/offers',
    '#settings/seller/tiers',
    '#settings/seller/customers/detail/customer-1',
  ]) {
    await page.goto(`${HARNESS_URL}?settle_reads=1${hash}`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(page.locator(
      '[data-recued-seller-page-state="ready"]',
    )).toBeVisible();

    const links = page.locator([
      '[data-recued-seller-back]:visible',
      '[data-recued-seller-collection-item-link]:visible',
      '[data-recued-seller-page-previous]:visible',
      '[data-recued-seller-page-next]:visible',
      '[data-recued-seller-contract-link]:visible',
      '.seller-related-links a:visible',
    ].join(', '));
    const linkHeights = await links.evaluateAll((targets) => targets.map(
      (target) => target.getBoundingClientRect().height,
    ));
    expect(linkHeights.length).toBeGreaterThan(0);
    expect(Math.min(...linkHeights)).toBeGreaterThanOrEqual(36);

    const buttonHeights = await page.locator(
      '[data-recued-seller-page] button:visible',
    ).evaluateAll((buttons) => buttons.map(
      (button) => button.getBoundingClientRect().height,
    ));
    expect(buttonHeights.length).toBeGreaterThan(0);
    expect(Math.min(...buttonHeights)).toBeGreaterThanOrEqual(36);

    const summaryHeights = await page.locator(
      '[data-recued-seller-page] summary:visible',
    ).evaluateAll((summaries) => summaries.map(
      (summary) => summary.getBoundingClientRect().height,
    ));
    expect(summaryHeights.every((height) => height >= 36)).toBe(true);

    const seller = page.locator('[data-recued-seller-page]');
    expect(await seller.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    )).toBe(true);

    if (hash.includes('/customers/detail/')) {
      const contractReference = seller.locator(
        `[${SHARED_REFERENCE_ID}="door_paged_01"]`,
      );
      await expect(contractReference).toHaveAttribute(
        SHARED_REFERENCE,
        'identity',
      );
      await expect(contractReference).toHaveAttribute(
        SHARED_REFERENCE_ID,
        'door_paged_01',
      );
    }
  }
});

test('Settings Seller Orders distinguishes repeated offer links', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/seller/orders'));

  const orderLink = (orderKey: string) => page.locator(
    `[data-recued-seller-collection-item-link="${orderKey}"]`,
  );
  await expect(orderLink('ord:access:claim-mail-1')).toHaveAccessibleName(
    'Preview order ord:access:claim-mail-1 for offer-1; press Enter to open',
  );
  await expect(orderLink('ord:access:claim-mail-2')).toHaveAccessibleName(
    'Preview order ord:access:claim-mail-2 for offer-1; press Enter to open',
  );
});

test('Settings Seller Usage distinguishes rollups for one contract', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/seller/usage'));

  const usageLink = (itemId: string) => page.locator(
    `[data-recued-seller-collection-item-link="${itemId}"]`,
  );
  await expect(usageLink(
    'door_paged_01:tool_call:day:1700000000000',
  )).toHaveAccessibleName(
    'Preview Tool Call usage for door_paged_01 (day 1700000000000); press Enter to open',
  );
  await expect(usageLink(
    'door_paged_01:chat_turn:day:1700000000000',
  )).toHaveAccessibleName(
    'Preview Chat Turn usage for door_paged_01 (day 1700000000000); press Enter to open',
  );
});

test('Settings Seller Offers distinguishes duplicate display names', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/seller/offers'));

  const offerLink = (offerId: string) => page.locator(
    `[data-recued-seller-collection-item-link="${offerId}"]`,
  );
  await expect(offerLink('offer-1')).toHaveAccessibleName(
    'Preview offer offer-1 (Consultation); press Enter to open',
  );
  await expect(offerLink('offer-2')).toHaveAccessibleName(
    'Preview offer offer-2 (Consultation); press Enter to open',
  );
});

test('Settings Seller Tiers distinguishes duplicate display names', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/seller/tiers'));

  const tierLink = (tierId: string) => page.locator(
    `[data-recued-seller-collection-item-link="${tierId}"]`,
  );
  await expect(tierLink('tier-standard')).toHaveAccessibleName(
    'Preview tier tier-standard (Standard); press Enter to open',
  );
  await expect(tierLink('tier-standard-annual')).toHaveAccessibleName(
    'Preview tier tier-standard-annual (Standard); press Enter to open',
  );
});

test('Settings Seller Customers distinguishes shared provider ids', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/seller/customers'));

  const customerLink = (customerId: string) => page.locator(
    `[data-recued-seller-collection-item-link="${customerId}"]`,
  );
  await expect(customerLink('customer-1')).toHaveAccessibleName(
    'Preview customer customer-1 (customer-shared); press Enter to open',
  );
  await expect(customerLink('customer-2')).toHaveAccessibleName(
    'Preview customer customer-2 (customer-shared); press Enter to open',
  );
});

test('Settings Seller customer lifecycle distinguishes repeated fields', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    window.__app.setHash('#settings/seller/customers/detail/customer-1');
  });
  await expect(page.getByRole('heading', {
    name: 'Look after someone’s access',
  })).toBeVisible();
  await page.locator(
    '[data-recued-seller-collection-detail="customer-1"] details',
  ).evaluateAll((details: HTMLDetailsElement[]) => {
    for (const detail of details) detail.open = true;
  });

  const field = (name: string) => page.locator(
    `[data-recued-seller-customer-lifecycle-field="${name}"]`,
  );
  for (const [name, accessibleName] of [
    ['extend.customer_id', 'Who to give longer'],
    ['swap.customer_id', 'Who to move'],
    ['close.customer_id', 'Customer to close'],
    ['reissue.customer_id', 'Customer to reissue'],
    ['message.customer_id', 'Customer to message'],
    ['extend.current_period_end', 'New end time'],
    ['swap.current_period_end', 'New end time'],
    ['extend.source_status', 'Extension source status'],
    ['swap.source_status', 'Swap source status'],
    ['close.source_status', 'Close source status'],
  ] as const) {
    await expect(field(name)).toHaveAccessibleName(accessibleName);
  }
});

test('Settings Seller confirmation dialog owns keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    window.__app.setHash(
      '#settings/seller/orders/detail/ord%3Aaccess%3Aclaim-mail-1',
    );
  });

  const trigger = page.locator(
    '[data-recued-seller-order-close="ord:access:claim-mail-1"]',
  );
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Close this order?' });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const confirm = dialog.getByRole('button', { name: 'Confirm & close' });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Settings Server Key Health distinguishes repeated key actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/server/key-health'));

  const keyAction = (action: 'rotate' | 'compromise', keyClass: string) =>
    page.locator(`[data-recued-key-health-${action}="${keyClass}"]`);
  await expect(keyAction('rotate', 'server_identity_key')).toHaveAccessibleName(
    'Rotate Server identity key now',
  );
  await expect(keyAction('compromise', 'server_identity_key'))
    .toHaveAccessibleName('Mark Server identity key compromised');
  await expect(keyAction('rotate', 'master_dek')).toHaveAccessibleName(
    'Rotate Master encryption key now',
  );
  await expect(keyAction('compromise', 'master_dek')).toHaveAccessibleName(
    'Mark Master encryption key compromised',
  );
  await expect(keyAction('rotate', 'publisher_identity_key'))
    .toHaveAccessibleName('Rotate Publisher identity key now');
  await expect(keyAction('compromise', 'publisher_identity_key'))
    .toHaveAccessibleName('Mark Publisher identity key compromised');
});

test('Settings Server Key Health states the unsealed backup boundary', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/server/key-health'));

  const posture = page.locator('[data-recued-keyfile-posture]');
  await expect(posture).toHaveAttribute(
    'data-recued-keyfile-posture-tone',
    'unsealed',
  );
  const consequence = posture.getByRole('alert');
  await expect(consequence).toContainText(
    'anyone who copies that whole folder gets everything in it',
  );
  await expect(consequence).toContainText(
    'Only a copy that leaves the keyfile out',
  );
  await expect(consequence).toContainText('database-only backup');
});

test('Settings Server Key Health retains confirmation focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/server/key-health'));

  const trigger = page.locator(
    '[data-recued-key-health-rotate="master_dek"]',
  );
  await trigger.click();
  const cancel = page.locator('[data-recued-key-health-cancel]');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator(
    '[data-recued-key-health-panel-state="idle"]',
  )).toBeVisible();
  await expect(trigger).toBeFocused();
});

test('Settings Server Maintenance dialog owns keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/server/maintenance'));

  const trigger = page.getByRole('button', {
    name: 'Run audit-compaction now',
  });
  await trigger.click();

  const dialog = page.getByRole('dialog', {
    name: 'Run "Compact repetitive audit rows"?',
  });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const confirm = dialog.getByRole('button', { name: 'Run now' });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() =>
    window.__app.rpcCallCount('housekeeping.task.run_now'))).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Settings Updates Check stays owned through failure and retry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?updates=fail-once-slow-retry`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/updates'));

  const check = page.locator(`[${UPDATES_CHECK}]`);
  const status = page.locator(`[${UPDATES_STATUS}]`);
  const error = page.locator(`[${UPDATES_ERROR}]`);
  await expect(check).toHaveText('Check for updates');
  await expect(status).toContainText('latest version');
  await expect(page.locator(`[${UPDATES_MODE}]`)).toHaveAccessibleName(
    'When updates are available',
  );
  expect((await check.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  const checksBefore = await page.evaluate(
    () => window.__app.rpcCallCount('update.check'),
  );

  await check.focus();
  await page.keyboard.press('Enter');
  await expect(check).toHaveText('Checking…');
  await expect(check).toHaveAttribute('aria-disabled', 'true');
  await expect(check).toHaveAttribute('aria-busy', 'true');
  await expect(check).not.toHaveAttribute('disabled');
  await expect(check).toBeFocused();
  await check.dispatchEvent('click');
  await check.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('update.check')),
  ).toBe(checksBefore + 1);

  await expect(error).toContainText('update check could not be completed');
  await expect(check).toHaveText('Check for updates');
  await expect(check).not.toHaveAttribute('aria-disabled');
  await expect(check).not.toHaveAttribute('aria-busy');
  await expect(check).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(status).toContainText('latest version');
  await expect(error).toBeHidden();
  await expect(check).toBeFocused();
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('update.check')),
  ).toBe(checksBefore + 2);
});

test('Settings Updates retains a pending rollback when navigation is declined', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?updates=ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/updates'));

  const rollback = page.locator(`[${UPDATES_ROLLBACK}]`);
  expect((await rollback.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  const html = page.locator('html');
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

  await rollback.focus();
  await page.keyboard.press('Enter');
  await expect(rollback).toHaveText('Rolling back…');
  await expect(rollback).not.toHaveAttribute('disabled');
  await expect(rollback).toHaveAttribute('aria-disabled', 'true');
  await expect(rollback).toHaveAttribute('aria-busy', 'true');
  await expect(rollback).toBeFocused();
  await rollback.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('update.rollback')),
  ).toBe(1);
  await page.evaluate(() => window.__app.setHash('#chat'));

  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A server update change is still in progress. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/updates$/);
  await expect(rollback).toHaveText('Rolling back…');
});

test('Settings Updates retains focus and ownership through a deferred apply', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?updates=available-slow-apply`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/updates'));

  const apply = page.locator(`[${UPDATES_APPLY}]`);
  const html = page.locator('html');
  await expect(apply).toHaveText('Update to 26.8.1');
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

  await apply.focus();
  // Every update asks once: Update to <version> → Confirm update → Updating….
  await page.keyboard.press('Enter');
  await expect(apply).toHaveText('Confirm update');
  await expect(apply).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(apply).toHaveText('Updating…');
  await expect(apply).not.toHaveAttribute('disabled');
  await expect(apply).toHaveAttribute('aria-disabled', 'true');
  await expect(apply).toHaveAttribute('aria-busy', 'true');
  await expect(apply).toBeFocused();
  await apply.dispatchEvent('click');
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('update.apply')),
  ).toBe(1);

  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'A server update change is still in progress. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/updates$/);

  // The confirm was used up by that apply, so the next attempt asks again.
  await expect(apply).toHaveText('Update to 26.8.1');
  await expect(apply).not.toHaveAttribute('aria-disabled');
  await expect(apply).not.toHaveAttribute('aria-busy');
  await expect(apply).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings Account gives dashboard handoffs full mobile targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?account=bound#settings/account`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const links = page.locator('.account-bind-dashboard-link');
  await expect(links).toHaveCount(3);
  const targets = await links.evaluateAll((elements) =>
    elements.map((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      target: element.getAttribute('target'),
      rel: element.getAttribute('rel'),
    }))
  );
  expect(Math.min(...targets.map((target) => target.width)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.min(...targets.map((target) => target.height)))
    .toBeGreaterThanOrEqual(36);
  expect(Math.max(...targets.map((target) => target.height)))
    .toBeLessThanOrEqual(44);
  expect(targets.every((target) => target.target === '_blank')).toBe(true);
  expect(targets.every((target) => target.rel === 'noopener noreferrer'))
    .toBe(true);
});

test('Settings Account Connect owns its pending command and refreshed binding', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=unbound&account_bind_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const connect = page.locator('[data-recued-account-binding-connect]');
  await expect(connect).toHaveText('Connect your recued.com account');
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
  await connect.focus();
  await page.keyboard.press('Enter');
  await expect(connect).toHaveText('Connecting…');
  await expect(connect).toHaveAttribute('aria-disabled', 'true');
  await expect(connect).toHaveAttribute('aria-busy', 'true');
  await expect(connect).not.toHaveAttribute('disabled');
  await expect(connect).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'An account setting is still updating. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/account$/);
  await connect.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('account.bind')),
  ).toBe(1);

  await expect(connect).toHaveText('Check the connection again');
  await expect(connect).not.toHaveAttribute('aria-disabled');
  await expect(connect).not.toHaveAttribute('aria-busy');
  await expect(connect).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-action-message]'))
    .toHaveText('Your server is hooked up to this recued.com account.');
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings Account Connect failures return to the exact command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=unbound&account_bind_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const connect = page.locator('[data-recued-account-binding-connect]');
  await connect.focus();
  await page.keyboard.press('Enter');
  await expect(connect).toHaveText('Connecting…');

  await expect(page.locator('[data-recued-account-binding-error="action"]'))
    .toHaveText('Account binding unavailable.');
  await expect(connect).toHaveText('Connect your recued.com account');
  await expect(connect).not.toHaveAttribute('aria-disabled');
  await expect(connect).not.toHaveAttribute('aria-busy');
  await expect(connect).not.toHaveAttribute('disabled');
  await expect(connect).toBeFocused();
});

test('Settings Account conflicts start safely and Cancel returns to Check the connection again', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?account=conflict`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const connect = page.locator('[data-recued-account-binding-connect]');
  await expect(connect).toHaveText('Check the connection again');
  await connect.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: 'Two accounts want this server' });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(connect).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-action-message]'))
    .toHaveText('Nothing was moved.');
});

test('Settings Account Yes, move it owns its pending command and refreshed binding', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=conflict&account_rebind_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const connect = page.locator('[data-recued-account-binding-connect]');
  await connect.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: 'Two accounts want this server' });
  const confirm = dialog.locator(
    '[data-recued-account-binding-confirm-rebind]',
  );
  const cancel = dialog.locator(
    '[data-recued-account-binding-cancel-rebind]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Rebinding…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await expect(cancel).not.toHaveAttribute('disabled');
  await confirm.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('account.bind')),
  ).toBe(2);

  await expect(dialog).toHaveCount(0);
  await expect(connect).toHaveText('Check the connection again');
  await expect(connect).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-action-message]'))
    .toHaveText('Your server now belongs to this recued.com account.');
});

test('Settings Account Yes, move it failures return to the exact command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=conflict&account_rebind_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const connect = page.locator('[data-recued-account-binding-connect]');
  await connect.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: 'Two accounts want this server' });
  const confirm = dialog.locator(
    '[data-recued-account-binding-confirm-rebind]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Rebinding…');
  await expect(confirm).toBeFocused();

  await expect(page.locator('[data-recued-account-binding-error="action"]'))
    .toHaveText('Account rebind unavailable.');
  await expect(dialog).toBeVisible();
  await expect(confirm).toHaveText('Yes, move it');
  await expect(confirm).not.toHaveAttribute('aria-disabled');
  await expect(confirm).not.toHaveAttribute('aria-busy');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
});

test('Settings Account Disconnect starts safely and Cancel returns to its command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?account=conflict`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const disconnect = page.locator('[data-recued-account-binding-unbind]');
  await disconnect.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', {
    name: 'Disconnect this server?',
  });
  const cancel = dialog.locator(
    '[data-recued-account-binding-cancel-unbind]',
  );
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    'This browser stays signed in, and you can hook the server back up later.',
  );
  await expect(cancel).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('account.unbind'),
  )).toBe(0);

  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(disconnect).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('account.unbind'),
  )).toBe(0);
});

test('Settings Account Confirm Disconnect owns its pending command and next action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=conflict&account_unbind_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  await page.locator('[data-recued-account-binding-unbind]').click();
  const dialog = page.getByRole('alertdialog', {
    name: 'Disconnect this server?',
  });
  const confirm = dialog.locator(
    '[data-recued-account-binding-confirm-unbind]',
  );
  const cancel = dialog.locator(
    '[data-recued-account-binding-cancel-unbind]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Disconnecting…');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await expect(cancel).toHaveAttribute('aria-disabled', 'true');
  await expect(cancel).not.toHaveAttribute('disabled');
  await confirm.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('account.unbind')),
  ).toBe(1);

  await expect(dialog).toHaveCount(0);
  const connect = page.locator('[data-recued-account-binding-connect]');
  await expect(connect).toHaveText('Connect your recued.com account');
  await expect(connect).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-action-message]'))
    .toHaveText('Your server is no longer hooked up to recued.com.');
  await expect(page.locator('[data-recued-account-binding-session]'))
    .toHaveText('Signed in as morgan@example.test');
});

test('Settings Account Confirm Disconnect failures return to the exact command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=conflict&account_unbind_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  await page.locator('[data-recued-account-binding-unbind]').click();
  const dialog = page.getByRole('alertdialog', {
    name: 'Disconnect this server?',
  });
  const confirm = dialog.locator(
    '[data-recued-account-binding-confirm-unbind]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Disconnecting…');
  await expect(confirm).toBeFocused();

  await expect(page.locator('[data-recued-account-binding-error="action"]'))
    .toHaveText('Account disconnect unavailable.');
  await expect(dialog).toBeVisible();
  await expect(confirm).toHaveText('Disconnect server');
  await expect(confirm).not.toHaveAttribute('aria-disabled');
  await expect(confirm).not.toHaveAttribute('aria-busy');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('account.unbind'),
  )).toBe(1);
});

test('Settings Account Sign out owns its pending command and next action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=bound&account_signout_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const signOut = page.locator('[data-recued-account-binding-signout]');
  await signOut.focus();
  await page.keyboard.press('Enter');
  await expect(signOut).toHaveText('Signing out…');
  await expect(signOut).toHaveAttribute('aria-disabled', 'true');
  await expect(signOut).toHaveAttribute('aria-busy', 'true');
  await expect(signOut).not.toHaveAttribute('disabled');
  await expect(signOut).toBeFocused();
  await signOut.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.accountSignOutCount?.()),
  ).toBe(1);

  await expect(signOut).toHaveCount(0);
  const connect = page.locator('[data-recued-account-binding-connect]');
  await expect(connect).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-session]'))
    .toHaveCount(0);
  await expect(page.locator('[data-recued-account-binding-action-message]'))
    .toHaveText(
      'Signed out of recued.com in this browser. Your server is still paired.',
    );
});

test('Settings Account Sign out failures return to the exact command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=bound&account_signout_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const signOut = page.locator('[data-recued-account-binding-signout]');
  await signOut.focus();
  await page.keyboard.press('Enter');
  await expect(signOut).toHaveText('Signing out…');
  await expect(signOut).toBeFocused();

  await expect(page.locator('[data-recued-account-binding-error="action"]'))
    .toHaveText('Account sign out unavailable.');
  await expect(signOut).toHaveText('Sign out');
  await expect(signOut).not.toHaveAttribute('aria-disabled');
  await expect(signOut).not.toHaveAttribute('aria-busy');
  await expect(signOut).not.toHaveAttribute('disabled');
  await expect(signOut).toBeFocused();
  expect(await page.evaluate(
    () => window.__app.accountSignOutCount?.(),
  )).toBe(1);
});

test('Settings Account read failures gate mutations and recover in place', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=read-fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const errors = page.locator('[data-recued-account-binding-error]');
  await expect(errors).toHaveCount(2);
  await expect(errors).toContainText([
    'Account binding status unavailable.',
    'Account plan status unavailable.',
  ]);
  expect(await page.evaluate(
    () => window.__app.accountSessionReadCount?.(),
  )).toBe(0);
  const connect = page.locator('[data-recued-account-binding-connect]');
  await expect(connect).toHaveCount(0);

  const retry = page.locator('[data-recued-account-binding-retry]');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Checking your account again…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('account.bindingStatus')),
  ).toBe(2);
  await expect(connect).toHaveCount(0);

  await expect(errors).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(connect).toHaveText('Connect your recued.com account');
  await expect(connect).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-session]'))
    .toHaveCount(0);
  expect(await page.evaluate(
    () => window.__app.accountSessionReadCount?.(),
  )).toBe(0);
});

test('Settings Account retry failures return to the exact recovery command', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?account=read-fail-twice-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/account'));

  const errors = page.locator('[data-recued-account-binding-error]');
  await expect(errors).toHaveCount(2);
  await expect(errors).toContainText([
    'Account binding status unavailable.',
    'Account plan status unavailable.',
  ]);
  expect(await page.evaluate(
    () => window.__app.accountSessionReadCount?.(),
  )).toBe(0);
  const retry = page.locator('[data-recued-account-binding-retry]');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Checking your account again…');
  await expect(retry).toBeFocused();

  await expect(errors).toHaveCount(1);
  await expect(errors.filter({
    hasText: 'Account binding status unavailable.',
  })).toHaveCount(1);
  await expect(retry).toHaveText('Check your account again');
  await expect(retry).not.toHaveAttribute('aria-disabled');
  await expect(retry).not.toHaveAttribute('aria-busy');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await expect(page.locator('[data-recued-account-binding-connect]'))
    .toHaveCount(0);
  expect(await page.evaluate(
    () => window.__app.rpcCallCount('account.bindingStatus'),
  )).toBe(2);
  expect(await page.evaluate(
    () => window.__app.accountSessionReadCount?.(),
  )).toBe(0);
});

test('Settings device revoke confirmation starts safely and returns to its row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?devices=ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));

  const currentRow = page.locator(
    '.account-devices-row[data-instance-id="device-current"]',
  );
  await expect(currentRow).toContainText('This device');
  await expect(currentRow.locator('[data-action="revoke-device"]')).toHaveCount(0);

  const revoke = page.locator(
    '[data-action="revoke-device"][data-instance-id="device-laptop"]',
  );
  await expect(revoke).toHaveAccessibleName(
    'Revoke Travel laptop (device-laptop)',
  );
  await expect(page.locator(
    '[data-action="revoke-device"][data-instance-id="device-desktop"]',
  )).toHaveAccessibleName('Revoke Office desktop (device-desktop)');
  await revoke.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', {
    name: 'Confirm revoke Travel laptop (device-laptop)',
  });
  const cancel = dialog.getByRole('button', {
    name: 'Cancel revoke Travel laptop (device-laptop)',
  });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await expect(dialog.getByRole('button', {
    name: 'Confirm revoke Travel laptop (device-laptop)',
  })).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(revoke).toBeFocused();
});

test('Settings device revoke owns its pending command and success receipt', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?devices=ready&device_revoke_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));

  const revoke = page.locator(
    '[data-action="revoke-device"][data-instance-id="device-laptop"]',
  );
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
  await revoke.click();
  const confirm = page.locator(
    '[data-action="confirm-revoke"][data-instance-id="device-laptop"]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');

  await expect(confirm).toHaveText('Revoking…');
  await expect(confirm).toHaveAccessibleName(
    'Revoking Travel laptop (device-laptop)',
  );
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  const html = page.locator('html');
  await expect(html).toHaveAttribute(
    'data-audit-confirm-message',
    'Recued is still shutting a device out. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/devices$/);
  await confirm.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('pair.revoke')),
  ).toBe(1);

  await expect(revoke).toHaveCount(0);
  const receipt = page.locator('[data-device-revoke-success]');
  await expect(receipt).toContainText('Done. That device can no longer reach this server.');
  await expect(receipt).toBeFocused();
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings failed device revokes return to the exact retry action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?devices=ready&device_revoke_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));

  await page.locator(
    '[data-action="revoke-device"][data-instance-id="device-laptop"]',
  ).click();
  const confirm = page.locator(
    '[data-action="confirm-revoke"][data-instance-id="device-laptop"]',
  );
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveText('Revoking…');

  await expect(page.locator('.account-devices-confirm-error'))
    .toHaveText(
      'Recued could not shut this device out: Device revoke unavailable. '
        + 'Try again, or do it from another device you have paired.',
    );
  await expect(confirm).toContainText('Yes, revoke');
  await expect(confirm).not.toHaveAttribute('aria-disabled');
  await expect(confirm).not.toHaveAttribute('aria-busy');
  await expect(confirm).not.toHaveAttribute('disabled');
  await expect(confirm).toBeFocused();
});

test('Settings Devices Retry owns recovery and advances into the roster', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?devices=fail-once-slow-retry`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));

  const retry = page.locator('[data-action="retry-list"]');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('pair.list')),
  ).toBe(2);

  await expect(retry).toHaveCount(0);
  await expect(page.locator(
    '[data-action="revoke-device"][data-instance-id="device-laptop"]',
  )).toBeFocused();
});

test('Settings Devices returns a failed roster Retry to its alert action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?devices=fail-twice-slow-retry`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/devices'));

  const retry = page.locator('[data-action="retry-list"]');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(retry).toHaveText('Retrying…');

  await expect(retry).toHaveText('Retry');
  await expect(retry).not.toHaveAttribute('aria-disabled');
  await expect(retry).not.toHaveAttribute('aria-busy');
  await expect(retry).toBeFocused();
  await expect(page.locator('[data-error="list"]')).toHaveAttribute(
    'role',
    'alert',
  );
});

// D-269 retired the Bridge row's CHANNEL switch (it decided nothing), and the
// two tests that drove it went with it. Their contracts live on in the
// per-browser twins below: mutation ownership, and failures that return to
// the exact control.
test('Settings keeps a pending notification write attached on route leave', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?notifications=ready&notifications_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  // D-269 — the per-device switch: the Bridge row's channel switch is gone,
  // and a pending per-device write must hold the route exactly as it did.
  const toggle = page.getByRole('switch', {
    name: 'Main browser notifications (bridge-main)',
    exact: true,
  });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveText('Updating…');

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
    'A notification setting is still updating. Leave Settings anyway?',
  );
  await expect(page).toHaveURL(/#settings\/notifications$/);
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveText('Notifications On');

  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings per-browser notification switches retain mutation ownership', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?notifications=ready&notifications_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  const toggle = page.getByRole('switch', {
    name: 'Main browser notifications (bridge-main)',
    exact: true,
  });
  await expect(toggle).toHaveText('Notifications Off');
  await toggle.focus();
  await page.keyboard.press('Enter');

  await expect(toggle).toHaveText('Updating…');
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).not.toHaveAttribute('disabled');
  await expect(toggle).toBeFocused();
  await toggle.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => window.__app.rpcCallCount('notifications.set_bridge_mode')),
  ).toBe(1);

  await expect(toggle).toHaveText('Notifications On');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).not.toHaveAttribute('aria-disabled');
  await expect(toggle).not.toHaveAttribute('aria-busy');
  await expect(toggle).toBeFocused();
});

test('Settings per-browser switch failures return to the exact control', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?notifications=ready&notifications_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  const toggle = page.locator(
    '[data-recued-notifications-bridge-mode-btn="bridge-main"]'
      + '[data-recued-notifications-bridge-mode="notification"]',
  );
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveText('Updating…');
  await expect(toggle).toBeFocused();

  await expect(page.getByRole('alert'))
    .toContainText('Browser notification setting unavailable.');
  await expect(toggle).toHaveText('Notifications Off');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).not.toHaveAttribute('aria-disabled');
  await expect(toggle).not.toHaveAttribute('aria-busy');
  await expect(toggle).toBeFocused();
});

test('Settings notification phrase Save retains mutation ownership', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?notifications=ready&notifications_response=slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  await expect(page.getByRole('heading', {
    name: 'Your secret phrase',
    level: 3,
  })).toBeVisible();
  const input = page.getByRole('textbox', {
    name: 'Your secret phrase',
    exact: true,
  });
  const save = page.getByRole('button', {
    name: 'Save your secret phrase',
    exact: true,
  });
  await input.fill('green fox');
  await save.focus();
  await page.keyboard.press('Enter');

  await expect(input).toHaveValue('green fox');
  await expect(input).toBeDisabled();
  await expect(save).toHaveText('Saving…');
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(save).not.toHaveAttribute('disabled');
  await expect(save).toBeFocused();
  await save.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(
    () => page.evaluate(() => (
      window.__app.rpcCallCount('notifications.set_verification_phrase')
    )),
  ).toBe(1);

  await expect(input).toHaveValue('green fox');
  await expect(input).not.toBeDisabled();
  await expect(save).toHaveText('Save');
  await expect(save).not.toHaveAttribute('aria-disabled');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).toBeFocused();
});

test('Settings notification phrase failures retain the draft and Save', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?notifications=ready&notifications_response=fail-slow`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  const input = page.locator('[data-recued-notifications-phrase-input]');
  const save = page.locator('[data-recued-notifications-phrase-save]');
  await input.fill('green fox');
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(save).toHaveText('Saving…');
  await expect(save).toBeFocused();

  await expect(page.getByRole('alert').filter({
    hasText: 'Verification phrase unavailable.',
  })).toBeVisible();
  await expect(input).toHaveValue('green fox');
  await expect(input).not.toBeDisabled();
  await expect(save).toHaveText('Save');
  await expect(save).not.toHaveAttribute('aria-disabled');
  await expect(save).not.toHaveAttribute('aria-busy');
  await expect(save).toBeFocused();
});

test('Settings guards an unsaved notification phrase until it is reverted', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?notifications=ready`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  const input = page.locator('[data-recued-notifications-phrase-input]');
  await expect(input).toHaveValue('blue lantern');
  await input.fill('unsaved phrase');
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
    'Discard the unsaved notification verification phrase?',
  );
  await expect(page).toHaveURL(/#settings\/notifications$/);
  await expect(input).toHaveValue('unsaved phrase');

  // Returning exactly to the authoritative value is no longer dirty and
  // should not force a needless confirmation.
  await input.fill('blue lantern');
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#chat$/);
  await expect(html).toHaveAttribute('data-audit-confirm-count', '1');
});

test('Settings notification Retry owns loading and advances into recovered controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `${HARNESS_URL}?notifications=fail-once-slow-retry`,
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => window.__app.setHash('#settings/notifications'));

  await expect(page.getByRole('alert'))
    .toContainText('Notification channels unavailable.');
  const describes = () =>
    page.evaluate(() => window.__app.rpcCallCount('notifications.describe'));
  // ⚠ NOT a fixed total. Two panels read this list on load (the channels and,
  // since D-269, "What you are notified about"), so the failed load alone is
  // two reads. Single-flight is the claim: Retry adds exactly ONE read.
  await expect.poll(describes).toBeGreaterThan(0);
  const beforeRetry = await describes();
  const retry = page.locator('[data-recued-notifications-retry]');
  await retry.focus();
  await page.keyboard.press('Enter');

  await expect(retry).toHaveText('Retrying…');
  await expect(retry).toHaveAttribute('aria-disabled', 'true');
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).not.toHaveAttribute('disabled');
  await expect(retry).toBeFocused();
  await retry.evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect.poll(describes).toBe(beforeRetry + 1);

  await expect(retry).toHaveCount(0);
  // D-269 — the Bridge row has no channel switch any more; its per-device
  // switches are the first recovered control, and Retry advances into them.
  const firstSwitch = page.getByRole('switch', {
    name: 'Main browser notifications (bridge-main)',
    exact: true,
  });
  await expect(firstSwitch).toHaveText('Notifications Off');
  await expect(firstSwitch).toBeFocused();
});

test('Settings Server tabs form one full-size arrow-key keyboard stop', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__app.setHash('#settings/server'));

  const tabs = page.locator(`[${SETTINGS_SUBTAB}]`);
  // D-272 — Connect a device comes FIRST (the beginner's question), and the
  // Reachability tab is gone, folded into it. The keyboard contract this test
  // is about did not change; only the tabs it walks did.
  const connect = page.locator(`[${SETTINGS_SUBTAB}="connect-device"]`);
  const exposure = page.locator(`[${SETTINGS_SUBTAB}="exposure"]`);
  const maintenance = page.locator(`[${SETTINGS_SUBTAB}="maintenance"]`);
  await expect(page.getByRole('tablist', {
    name: 'Server sections',
  })).toBeVisible();
  await expect(connect).toHaveAttribute('tabindex', '0');
  expect(await tabs.evaluateAll((nodes) => nodes.filter(
    (node) => node.getAttribute('tabindex') === '0',
  ).length)).toBe(1);
  const tabHeights = await tabs.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height)
  );
  expect(Math.min(...tabHeights)).toBeGreaterThanOrEqual(36);

  await connect.focus();
  await page.keyboard.press('ArrowRight');
  await expect(exposure).toHaveAttribute('aria-selected', 'true');
  await expect(exposure).toHaveAttribute('tabindex', '0');
  await expect(exposure).toBeFocused();

  await page.keyboard.press('End');
  await expect(maintenance).toHaveAttribute('aria-selected', 'true');
  await expect(maintenance).toBeFocused();
  await page.keyboard.press('Home');
  await expect(connect).toHaveAttribute('aria-selected', 'true');
  await expect(connect).toBeFocused();
});

test('Settings Exposure confirmations own keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${HARNESS_URL}?settle_reads=1#settings/server/exposure`);
  await page.waitForFunction(() => window.__app?.ready === true);

  const cellInputs = page.locator('.exposure-cell-checkbox');
  const cellTargets = page.locator('.exposure-cell-target');
  const cellCount = await cellInputs.count();
  expect(cellCount).toBeGreaterThan(0);
  await expect(cellTargets).toHaveCount(cellCount);
  for (let index = 0; index < await cellTargets.count(); index += 1) {
    const box = await cellTargets.nth(index).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(36);
    expect(box?.height).toBeGreaterThanOrEqual(36);
  }
  await expect(page.locator('html')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('html').evaluate((element) => element.clientWidth),
  );

  const trigger = page.locator(`[${EXPOSURE_PUBLIC_MCP}]`);
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: 'Let AI apps in from outside?' });
  const phrase = dialog.getByRole('textbox', {
    name: 'Type "enable public MCP" to confirm',
  });
  const cancel = dialog.locator(`[${EXPOSURE_MODAL_CANCEL}]`);
  const submit = dialog.locator(`[${EXPOSURE_MODAL_SUBMIT}]`);
  await expect(dialog).toBeVisible();
  await expect(phrase).toBeFocused();

  // Every keystroke replaces the modal DOM from its state machine. Focus and
  // the caret must follow the replacement input instead of dropping to body.
  await page.keyboard.type('enable public MCP');
  await expect(phrase).toHaveValue('enable public MCP');
  await expect(phrase).toBeFocused();
  await expect(submit).toBeEnabled();

  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(submit).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(phrase).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(submit).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  const wsTrigger = page.locator(`[${EXPOSURE_CELL}="ws.lan"]`);
  await wsTrigger.click();
  const wsDialog = page.getByRole('dialog', {
    name: 'Cut this browser off?',
  });
  await expect(wsDialog.getByRole('textbox', {
    name: 'Type "disconnect webclients" to confirm',
  })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(wsDialog).toHaveCount(0);
  await expect(wsTrigger).toBeFocused();
});
