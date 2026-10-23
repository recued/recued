import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
/** D-318 step 7 — Settings → Email chat in a real browser: what a fake DOM
 *  cannot see. The panel's own stylesheet applied, the controls in bounds on a
 *  phone, and the switch-on and round-trip flows driven by clicks. Step 8 — an
 *  address added, its code shown, and each of its states in bounds too. */
import { expect, test, type Page } from '@playwright/test';
import type {} from './harness/mail-chat-door-harness.js';

const BASE = `${process.env.E2E_MAIL_CHAT_DOOR_HARNESS_URL ?? HARNESS_ORIGIN}/mail-chat-door-harness.html`;
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

test('§8.18 — one mailbox: the chat mailbox ticked as yours, on to write to yourself, the prefix kept on, in bounds on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(at('chat-pick')).selectOption('recued-chat');
  const itself = page.locator(at('owner-pick', 'recued-chat'));
  await expect(itself).toBeVisible();
  await itself.check();
  await expect(page.getByText(/^You write to yourself at recued@chat\.example\./)).toBeVisible();
  await page.locator(at('confirm')).check();
  const overflow = async (): Promise<string[]> => page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-recued-mail-chat-door-panel]')!;
    const box = panel.getBoundingClientRect();
    return [...panel.querySelectorAll<HTMLElement>('button, input, select, label, p, li')]
      .filter((el) => el.getBoundingClientRect().right > box.right + 1)
      .map((el) => el.outerHTML.slice(0, 80));
  });
  expect(await overflow()).toEqual([]);
  await page.locator(at('turn-on')).click();
  await expect(page.getByText('Email chat is on. Write to yourself at recued@chat.example.')).toBeVisible();
  // The prefix cannot be switched off here.
  await expect(page.locator(at('prefix-on'))).toBeChecked();
  await expect(page.locator(at('prefix-on'))).toBeDisabled();
  await expect(page.getByText('Send an email to yourself, recued@chat.example, with the subject')).toBeVisible();
  expect(await overflow()).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const sets = await page.evaluate(() => window.__mcd.calls
    .filter((call) => call.method === 'collection.mail.chat_door.set').map((call) => call.args));
  expect(sets).toEqual([{ chat_mailbox: 'recued-chat', owner_mailboxes: ['recued-chat'] }]);
});

test.describe('Email chat read recovery', () => {
  const openFailedRead = async (page: Page, width: number, failure: 'settings' | 'mailboxes') => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}?read_failure=${failure}`);
    const panel = page.locator('[data-recued-mail-chat-door-panel]');
    await expect(panel).toHaveAttribute('data-recued-mail-chat-door-state', 'error');
    await expect(panel.getByRole('alert')).toContainText(`Email chat ${failure} temporarily unavailable.`);
    await page.evaluate(() => {
      const outside = document.createElement('button');
      outside.textContent = 'Outside the Email chat panel';
      outside.setAttribute('data-email-chat-outside', '');
      document.body.appendChild(outside);
    });
    return {
      panel, retry: page.locator(at('retry')),
      outside: page.locator('[data-email-chat-outside]'),
    };
  };

  for (const width of [390, 1280]) {
    for (const failure of ['settings', 'mailboxes'] as const) {
      for (const outcome of ['success', 'failure'] as const) {
        for (const moveAway of [false, true]) {
          test(`${failure} retry ${outcome} respects ${moveAway ? 'moved' : 'owned'} focus at ${width}px`, async ({ page }) => {
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(error.message));
            const { panel, retry, outside } = await openFailedRead(page, width, failure);
            expect(await page.evaluate(() => window.__mcd.readCounts())).toEqual({ settings: 1, mailboxes: 1 });
            await page.evaluate(({ failure, outcome }) => {
              window.__mcd.holdReads();
              if (outcome === 'failure') window.__mcd.failNextRead(failure);
            }, { failure, outcome });
            await retry.focus();
            await page.keyboard.press('Enter');
            await expect(panel.getByRole('status')).toHaveText('Retrying Email chat settings…');
            await expect(retry).toHaveText('Retrying…');
            await expect(retry).toHaveAttribute('aria-disabled', 'true');
            await expect(retry).toHaveAttribute('aria-busy', 'true');
            await expect(retry).toHaveJSProperty('disabled', false);
            await expect(retry).toBeFocused();
            await expect(retry).toBeInViewport({ ratio: 1 });
            await retry.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
            await page.evaluate(() => { void window.__mcd.refresh(); void window.__mcd.refresh(); });
            expect(await page.evaluate(() => window.__mcd.readCounts())).toEqual({ settings: 2, mailboxes: 2 });
            if (moveAway) await outside.focus();
            expect(await page.evaluate(() => window.__mcd.releaseRead('settings'))).toBe(1);
            await page.evaluate(() => { void window.__mcd.refresh(); });
            await expect(panel).toHaveAttribute('data-recued-mail-chat-door-state', 'loading');
            expect(await page.evaluate(() => window.__mcd.readCounts())).toEqual({ settings: 2, mailboxes: 2 });
            expect(await page.evaluate(() => window.__mcd.releaseReads())).toBe(1);
            if (outcome === 'failure') {
              await expect(panel).toHaveAttribute('data-recued-mail-chat-door-state', 'error');
              await expect(panel.getByRole('alert')).toContainText(`Email chat ${failure} temporarily unavailable.`);
              await expect(retry).toHaveText('Retry Email chat settings');
              await expect(retry).not.toHaveAttribute('aria-busy');
              if (moveAway) await expect(outside).toBeFocused();
              else await expect(retry).toBeFocused();
              await retry.focus();
              await page.keyboard.press('Enter');
            }
            await expect(panel).toHaveAttribute('data-recued-mail-chat-door-state', 'off');
            await expect(retry).toHaveCount(0);
            await expect(panel.getByRole('alert')).toHaveCount(0);
            if (moveAway && outcome === 'success') await expect(outside).toBeFocused();
            else await expect(page.locator(at('chat-pick'))).toBeFocused();
            const reads = outcome === 'failure' ? 3 : 2;
            expect(await page.evaluate(() => window.__mcd.readCounts())).toEqual({ settings: reads, mailboxes: reads });
            expect(await page.evaluate(() => window.__mcd.calls)).toEqual([]);
            expect(errors).toEqual([]);
          });
        }
      }
    }

    for (const moveAway of [false, true]) {
      test(`recovers enabled Email chat with ${moveAway ? 'moved' : 'owned'} focus at ${width}px`, async ({ page }) => {
        const { panel, retry, outside } = await openFailedRead(page, width, 'settings');
        await page.evaluate(() => window.__mcd.holdReads());
        await retry.focus();
        await page.keyboard.press('Enter');
        await page.evaluate(() => {
          void window.__mcd.setSettings({
            chat_mailbox: 'recued-chat', chat_address: 'recued@chat.example', owner_mailboxes: ['me'],
          });
        });
        if (moveAway) await outside.focus();
        expect(await page.evaluate(() => window.__mcd.releaseReads())).toBe(2);
        await expect(panel).toHaveAttribute('data-recued-mail-chat-door-state', 'on');
        await expect(retry).toHaveCount(0);
        if (moveAway) await expect(outside).toBeFocused();
        else await expect(page.locator(at('prefix-on'))).toBeFocused();
        expect(await page.evaluate(() => window.__mcd.readCounts())).toEqual({ settings: 2, mailboxes: 2 });
        expect(await page.evaluate(() => window.__mcd.calls)).toEqual([]);
      });
    }
  }
});

test.describe('Email chat draft continuity', () => {
  const openEditing = async (page: Page, width: number, kind: 'verification' | 'round trip' | 'none') => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}?manual_timers=1`);
    await page.evaluate(async kind => {
      await window.__mcd.setSettings({
        chat_mailbox: 'recued-chat', chat_address: 'recued@chat.example', owner_mailboxes: ['me'],
        enrolled_senders: kind === 'verification' ? [{
          address: 'pending@personal.example', state: 'pending', chat_mailbox: 'recued-chat', code: '482913',
          expires_at: Date.now() + 900_000, attempts: 0, added_at: Date.now(), confirmed_at: null,
          checked_by: null, failure: null,
        }] : [],
      });
      const outside = document.createElement('button');
      outside.setAttribute('data-email-chat-outside', '');
      outside.textContent = 'Outside the Email chat panel';
      document.body.appendChild(outside);
    }, kind);
    const panel = page.locator('[data-recued-mail-chat-door-panel]');
    await expect(panel).toHaveAttribute('data-recued-mail-chat-door-state', 'on');
    if (kind === 'round trip') {
      await page.locator(at('test-start')).click();
      await expect(panel.getByText('Waiting for your email…')).toBeVisible();
    }
    return { panel, outside: page.locator('[data-email-chat-outside]') };
  };

  const confirmAddress = async (page: Page) => page.evaluate(() => window.__mcd.settle('pending@personal.example', {
    state: 'confirmed', confirmed_at: Date.now(), checked_by: 'mx.zohomail.com',
  }));

  for (const width of [390, 1280]) {
    for (const kind of ['verification', 'round trip'] as const) {
      for (const field of ['prefix', 'prefix-on', 'stale', 'enrol-input'] as const) {
        for (const moveAway of [false, true]) {
          test(`${kind} keeps ${field} drafts with ${moveAway ? 'outside' : 'field'} focus at ${width}px`, async ({ page }) => {
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(error.message));
            const { panel, outside } = await openEditing(page, width, kind);
            await page.locator(at('prefix')).fill('reply:');
            await page.locator(at('stale')).fill('47');
            await page.locator(at('enrol-input')).fill('second@personal.example');
            if (field === 'prefix-on') await page.locator(at('prefix-on')).uncheck();
            const editing = page.locator(at(field));
            await editing.focus();
            if (field === 'prefix') await editing.evaluate(node => (node as HTMLInputElement).setSelectionRange(2, 5, 'backward'));
            const before = await page.evaluate(() => ({ reads: window.__mcd.readCounts(), recent: window.__mcd.recentReadCount() }));
            expect(await page.evaluate(kind => {
              if (kind === 'verification') window.__mcd.holdReads();
              else window.__mcd.holdRecent();
              return window.__mcd.tick();
            }, kind)).toBe(1);
            if (moveAway) await outside.focus();
            if (kind === 'verification') {
              await confirmAddress(page);
              expect(await page.evaluate(() => window.__mcd.releaseReads())).toBe(1);
              await expect(page.locator(at('enrol-sender', 'pending@personal.example')))
                .toHaveAttribute('data-recued-mail-chat-door-enrol-state', 'confirmed');
            } else {
              expect(await page.evaluate(() => {
                window.__mcd.setRecent([{
                  arrived_at: Date.UTC(2026, 9, 14, 9, 31), from: 'me@owner.example', state: 'proven', proof: 'sent_record',
                  reason: null, chat: 'admitted', chat_reason: null, sender_auth: 'pass', answer: 'sent',
                  answered_at: Date.UTC(2026, 9, 14, 9, 32),
                }]);
                return window.__mcd.releaseRecent();
              })).toBe(1);
              await expect(panel.locator(at('test')).getByText('Answer sent at 09:32. Look for it in your inbox.')).toBeVisible();
            }
            await expect(page.locator(at('prefix'))).toHaveValue('reply:');
            await expect(page.locator(at('stale'))).toHaveValue('47');
            await expect(page.locator(at('enrol-input'))).toHaveValue('second@personal.example');
            await expect(page.locator(at('prefix-on'))).toBeChecked({ checked: field !== 'prefix-on' });
            await expect(page.locator(at('prefix'))).toHaveJSProperty('disabled', field === 'prefix-on');
            if (moveAway) await expect(outside).toBeFocused();
            else {
              await expect(editing).toBeFocused();
              if (field === 'prefix') expect(await editing.evaluate(node => {
                const input = node as HTMLInputElement;
                return [input.selectionStart, input.selectionEnd, input.selectionDirection];
              })).toEqual([2, 5, 'backward']);
            }
            const after = await page.evaluate(() => ({ reads: window.__mcd.readCounts(), recent: window.__mcd.recentReadCount() }));
            expect(after).toEqual({
              reads: { ...before.reads, settings: before.reads.settings + (kind === 'verification' ? 1 : 0) },
              recent: before.recent + (kind === 'round trip' ? 1 : 0),
            });
            expect(await page.evaluate(() => window.__mcd.calls)).toEqual([]);
            expect(errors).toEqual([]);
          });
        }
      }
    }

    test(`keeps the new field owner when focus moves within a pending verification at ${width}px`, async ({ page }) => {
      await openEditing(page, width, 'verification');
      await page.locator(at('prefix')).fill('reply:');
      await page.evaluate(() => { window.__mcd.holdReads(); window.__mcd.tick(); });
      await page.locator(at('stale')).fill('55');
      await confirmAddress(page);
      await page.evaluate(() => window.__mcd.releaseReads());
      await expect(page.locator(at('enrol-sender', 'pending@personal.example')))
        .toHaveAttribute('data-recued-mail-chat-door-enrol-state', 'confirmed');
      await expect(page.locator(at('stale'))).toBeFocused();
      await expect(page.locator(at('stale'))).toHaveValue('55');
      await expect(page.locator(at('prefix'))).toHaveValue('reply:');
    });

    test(`keeps a refused save and releases only saved drafts after retry at ${width}px`, async ({ page }) => {
      await openEditing(page, width, 'none');
      await page.locator(at('prefix')).fill(' reply: ');
      await page.locator(at('stale')).fill('47');
      await page.locator(at('enrol-input')).fill('second@personal.example');
      await page.evaluate(() => window.__mcd.failNextSet('Settings not saved.'));
      await page.locator(at('save')).click();
      await expect(page.locator(at('error'))).toHaveText('Settings not saved.');
      await expect(page.locator(at('prefix'))).toHaveValue(' reply: ');
      await expect(page.locator(at('stale'))).toHaveValue('47');
      await page.locator(at('save')).click();
      await expect(page.locator(at('error'))).toHaveCount(0);
      await expect(page.locator(at('prefix'))).toHaveValue('reply:');
      await page.evaluate(() => window.__mcd.setSettings({ ask_prefix: 'server:', stale_after_minutes: 90 }));
      await expect(page.locator(at('prefix'))).toHaveValue('server:');
      await expect(page.locator(at('stale'))).toHaveValue('90');
      await expect(page.locator(at('enrol-input'))).toHaveValue('second@personal.example');
      expect(await page.evaluate(() => window.__mcd.calls)).toEqual([1, 2].map(() => ({
        method: 'collection.mail.chat_door.set', args: { ask_prefix: 'reply:', stale_after_minutes: 47 },
      })));
    });

    test(`keeps invalid drafts so they can be corrected at ${width}px`, async ({ page }) => {
      await openEditing(page, width, 'none');
      await page.locator(at('prefix')).fill('reply:');
      await page.locator(at('stale')).fill('');
      await page.locator(at('save')).click();
      await expect(page.locator(at('error'))).toContainText('Enter whole minutes');
      await expect(page.locator(at('prefix'))).toHaveValue('reply:');
      await expect(page.locator(at('stale'))).toHaveValue('');
      await page.locator(at('stale')).fill('47');
      await page.locator(at('prefix')).fill('');
      await page.locator(at('save')).click();
      await expect(page.locator(at('error'))).toContainText('Enter a prefix');
      await expect(page.locator(at('prefix'))).toHaveValue('');
      await expect(page.locator(at('stale'))).toHaveValue('47');
      expect(await page.evaluate(() => window.__mcd.calls)).toEqual([]);
      await page.locator(at('prefix')).fill('reply:');
      await page.locator(at('save')).click();
      await expect(page.locator(at('error'))).toHaveCount(0);
      expect(await page.evaluate(() => window.__mcd.calls)).toEqual([{
        method: 'collection.mail.chat_door.set', args: { ask_prefix: 'reply:', stale_after_minutes: 47 },
      }]);
    });
  }
});
