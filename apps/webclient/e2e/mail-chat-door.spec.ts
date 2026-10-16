/** D-318 step 7 — Settings → Email chat in a real browser: what a fake DOM
 *  cannot see. The panel's own stylesheet applied, the controls in bounds on a
 *  phone, and the switch-on and round-trip flows driven by clicks. Step 8 — an
 *  address added, its code shown, and each of its states in bounds too. */
import { expect, test, type Page } from '@playwright/test';
import type {} from './harness/mail-chat-door-harness.js';

const BASE = `${process.env.E2E_MAIL_CHAT_DOOR_HARNESS_URL ?? 'http://127.0.0.1:4319'}/mail-chat-door-harness.html`;
const at = (attr: string, value?: string): string =>
  value === undefined ? `[data-recued-mail-chat-door-${attr}]` : `[data-recued-mail-chat-door-${attr}="${value}"]`;

const fillIn = async (page: Page): Promise<void> => {
  await page.locator(at('chat-pick')).selectOption('recued-chat');
  await page.locator(at('owner-pick', 'me')).check();
  await page.locator(at('confirm')).check();
};

test.beforeEach(async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('[data-recued-mail-chat-door-panel]')).toHaveAttribute('data-recued-mail-chat-door-state', 'off');
});

test('the panel is styled, and a mailbox that cannot send is offered but cannot be picked', async ({ page }) => {
  const panel = page.locator('[data-recued-mail-chat-door-panel]');
  // Its own stylesheet applied: the card's border, the disclosure's rule.
  await expect(panel).toHaveCSS('border-top-width', '1px');
  await expect(page.locator(at('disclosure'))).toHaveCSS('border-left-width', '3px');
  // ⚠ Playwright's toBeDisabled does not read an <option>: the property does.
  await expect(page.locator(at('chat-pick')).locator('option[value="archive"]')).toHaveJSProperty('disabled', true);
  await expect(page.locator(at('turn-on'))).toBeDisabled();
});

test('switching on checks first, saves past the checks, and the round trip shows each step', async ({ page }) => {
  await fillIn(page);
  await expect(page.locator(at('turn-on'))).toBeEnabled();
  await page.locator(at('turn-on')).click();
  await expect(page.locator('[data-recued-mail-chat-door-panel]')).toHaveAttribute('data-recued-mail-chat-door-state', 'on');
  const methods = await page.evaluate(() => window.__mcd.calls.map((call) => call.method));
  expect(methods).toEqual(['collection.mail.chat_door.check', 'collection.mail.chat_door.set']);
  await expect(page.getByText('Waiting for your email…')).toBeVisible();

  await page.evaluate(() => window.__mcd.setRecent([{
    arrived_at: Date.UTC(2026, 9, 14, 9, 31), from: 'me@owner.example', state: 'proven', proof: 'sent_record', reason: null,
    chat: 'admitted', chat_reason: null, sender_auth: 'pass', answer: 'sent', answered_at: Date.UTC(2026, 9, 14, 9, 32),
  }]));
  // In the test's own steps: the recent list says the last step too.
  const steps = page.locator(at('test'));
  await expect(steps.getByText('Found in your Sent folder: it is yours.')).toBeVisible();
  await expect(steps.getByText('Answer sent at 09:32. Look for it in your inbox.')).toBeVisible();
});

test('a check that fails keeps it off and says what to fix', async ({ page }) => {
  await page.evaluate(() => window.__mcd.setCheck({
    ready: false,
    checks: [{ kind: 'owner_mailbox', slug: 'me', status: 'fail', text: 'Recued cannot look in its Sent folder.' }],
  }));
  await fillIn(page);
  await page.locator(at('turn-on')).click();
  await expect(page.locator(at('check', 'me'))).toHaveAttribute('data-recued-mail-chat-door-check-status', 'fail');
  await expect(page.getByText('Email chat is still off. Fix what is marked ✗, then try again.')).toBeVisible();
  const methods = await page.evaluate(() => window.__mcd.calls.map((call) => call.method));
  expect(methods).toEqual(['collection.mail.chat_door.check']);
});

test('on a phone, every control stays inside the panel, switched off and on', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const inBounds = async (): Promise<void> => {
    const overflow = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-recued-mail-chat-door-panel]')!;
      const box = panel.getBoundingClientRect();
      return [...panel.querySelectorAll<HTMLElement>('button, input, select, label, p, li')]
        .filter((el) => el.getBoundingClientRect().right > box.right + 1)
        .map((el) => el.outerHTML.slice(0, 80));
    });
    expect(overflow).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };
  await inBounds();
  await fillIn(page);
  await page.locator(at('turn-on')).click();
  await expect(page.locator(at('test'))).toBeVisible();
  await page.evaluate(() => window.__mcd.setSettings({ paused_at: Date.UTC(2026, 9, 14, 9, 31) }));
  await expect(page.locator(at('paused'))).toBeVisible();
  await inBounds();
});

test('D-318 step 8 — an address added shows its code, settles when its email arrives, and stays in bounds on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fillIn(page);
  await page.locator(at('turn-on')).click();
  await expect(page.locator(at('enrol'))).toBeVisible();
  // A long address must wrap, not push the panel wider.
  const long = 'firstname.lastname.for.work.and.home@a-long-personal-domain.example';
  await page.locator(at('enrol-input')).fill(long);
  await page.locator(at('enrol-add')).click();
  const item = page.locator(at('enrol-sender', long));
  await expect(item).toHaveAttribute('data-recued-mail-chat-door-enrol-state', 'pending');
  await expect(item.locator(at('enrol-code'))).toHaveText('482913');
  await expect(item.locator(at('enrol-code'))).toHaveCSS('font-family', /mono/i);
  const inBounds = async (): Promise<void> => {
    const overflow = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-recued-mail-chat-door-panel]')!;
      const box = panel.getBoundingClientRect();
      return [...panel.querySelectorAll<HTMLElement>('button, input, select, label, p, li, strong')]
        .filter((el) => el.getBoundingClientRect().right > box.right + 1)
        .map((el) => el.outerHTML.slice(0, 80));
    });
    expect(overflow).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };
  await inBounds();
  // The code's email arrives and passes: the next look shows it.
  await page.evaluate((address) => window.__mcd.settle(address, {
    state: 'confirmed', confirmed_at: Date.UTC(2026, 9, 14, 9, 33), checked_by: 'mx.zohomail.com',
  }), long);
  await expect(item).toHaveAttribute('data-recued-mail-chat-door-enrol-state', 'confirmed');
  await expect(item.getByText('Added. Each email from it must pass the sender check by zohomail.com.')).toBeVisible();
  await inBounds();
  // And one that did not pass.
  await page.locator(at('enrol-input')).fill('second@personal.example');
  await page.locator(at('enrol-add')).click();
  await page.evaluate(() => window.__mcd.settle('second@personal.example', { state: 'failed', failure: 'no_check' }));
  await expect(page.locator(at('enrol-sender', 'second@personal.example')))
    .toHaveAttribute('data-recued-mail-chat-door-enrol-state', 'failed');
  // Its reason reads as a problem: not the colour of the added one's line.
  const colour = (address: string) => page.locator(at('enrol-sender', address)).locator('p').first()
    .evaluate((el) => getComputedStyle(el).color);
  expect(await colour('second@personal.example')).not.toBe(await colour(long));
  await inBounds();
  const sets = await page.evaluate(() => window.__mcd.calls
    .filter((call) => call.method === 'collection.mail.chat_door.set').map((call) => call.args));
  expect(sets).toEqual([
    { chat_mailbox: 'recued-chat', owner_mailboxes: ['me'] },
    { enroll: long },
    { enroll: 'second@personal.example' },
  ]);
});
