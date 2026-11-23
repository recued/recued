/** D-404 slices A and B1, in a real browser: an answer whose search found no passport shows "No
 *  Passport in Yours yet." with Add a Passport, and a pack the marketplace has. Once a step lands (the
 *  server says so; asked again when the owner's things or packs change), its line says so and the
 *  block offers Ask again (ruling P2), which sends the request that started the turn, and nothing else. */
import { expect, test } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';

declare global { interface Window {
  __chatStepsLanded?: Array<{ kind: string; id: string }>;
  __chatStepsSent?: Array<{ message?: string; session_id?: string }>;
  __chatHintsNotNow?: Array<{ key: string; label: string; until: number }>;
} }

installFullAppHooks();

const open = async (page: import('@playwright/test').Page) => {
  await page.goto(`${HARNESS_URL}?chat=session&chat_steps=1&yours=demo#chat/session/chat_1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  return page.locator('[data-chat-fixes]');
};
/** A change to the owner's things, as the realtime bus delivers one. */
const warehouseChanged = (page: import('@playwright/test').Page) => page.evaluate(() => window.__app.fireMessage({ type: 'server_event',
  event: { kind: 'warehouse', collection: 'asset', op: 'insert', id: 'asset-new', cursor: Date.now() } }));

test('D-404 — "Add a Passport" under the answer opens Yours\' form with Passport chosen', async ({ page }) => {
  const fixes = await open(page);
  await expect(fixes.getByText('No Passport in Yours yet.', { exact: true })).toBeVisible();
  await expect(page.locator('[data-chat-install-offers]').getByRole('link', { name: 'Get Rental Book', exact: true })).toBeVisible();
  await expect(page.locator('[data-chat-ask-again]')).toHaveCount(0);
  await fixes.getByRole('link', { name: 'Add a Passport', exact: true }).click();
  // D-404 slice B2 — the link carries the answer; the form offers the way back to it.
  await expect(page).toHaveURL(/#yours\/new\/passport\/return\/chat\/chat_1\/message_steps_answer$/u);
  await page.locator('[data-yours-back-to-chat]').click();
  await expect(page).toHaveURL(/#chat\/session\/chat_1\/answer\/message_steps_answer$/u);
  await expect(page.locator('[data-chat-fixes]').getByText('No Passport in Yours yet.', { exact: true })).toBeVisible();
});

test('D-404 slice B1 — once the step lands, the line says so and Ask again sends the request, once', async ({ page }) => {
  const fixes = await open(page);
  await expect(fixes.getByText('No Passport in Yours yet.', { exact: true })).toBeVisible();
  const asked = await page.evaluate(() => window.__app.rpcCallCount('chat.next_steps.state'));
  expect(asked).toBeGreaterThan(0);
  // The owner adds a passport elsewhere: the bus says the owner's things changed, the page asks again.
  await page.evaluate(() => { window.__chatStepsLanded = [{ kind: 'thing', id: 'passport' }]; });
  await warehouseChanged(page);
  await expect(fixes.getByText('A Passport is in Yours now.', { exact: true })).toBeVisible();
  await expect(fixes.getByRole('link', { name: 'Add a Passport', exact: true })).toHaveCount(0);
  // The pack has not landed: its link stays.
  await expect(page.locator('[data-chat-install-offers]').getByRole('link', { name: 'Get Rental Book', exact: true })).toBeVisible();
  const ask = fixes.getByRole('button', { name: 'Ask again', exact: true });
  await ask.click();
  await expect(fixes.getByText('Asked again.', { exact: true })).toBeVisible();
  const sent = await page.evaluate(() => window.__chatStepsSent ?? []);
  expect(sent.map((args) => args.message)).toEqual(['When does my passport expire?']);
});

test('D-404 slice B1 — a pack installed reads so, with its own Ask again', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.__chatStepsLanded = [{ kind: 'pack', id: 'rental-book' }]; });
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: { kind: 'pack_installed', slug: 'rental-book', cursor: Date.now() } }));
  const offers = page.locator('[data-chat-install-offers]');
  await expect(offers.getByText('Rental Book is installed.', { exact: true })).toBeVisible();
  await expect(offers.getByRole('button', { name: 'Ask again', exact: true })).toBeVisible();
});

test('D-404 slice B1 — ⛔ Ask again never sends what the composer holds: it says why and sends nothing', async ({ page }) => {
  const fixes = await open(page);
  await page.evaluate(() => { window.__chatStepsLanded = [{ kind: 'thing', id: 'passport' }]; });
  await warehouseChanged(page);
  await expect(fixes.getByText('A Passport is in Yours now.', { exact: true })).toBeVisible();
  await page.locator('[data-recued-chat-route-input]').fill('A half-written question');
  await fixes.getByRole('button', { name: 'Ask again', exact: true }).click();
  await expect(fixes.getByRole('alert')).toHaveText('Send or clear the message you are writing, then ask again.');
  expect(await page.evaluate(() => window.__chatStepsSent ?? [])).toEqual([]);
  await expect(page.locator('[data-recued-chat-route-input]')).toHaveValue('A half-written question');
});

test('D-404 slice B2 — a standalone recipe\'s offer opens its install with Back to chat', async ({ page }) => {
  await open(page);
  await page.locator('[data-chat-install-offers]').getByRole('link', { name: 'Get Summarize a PDF', exact: true }).click();
  await expect(page).toHaveURL(/#recipes\/install\/summarize-pdf\/return\/chat\/chat_1\/message_steps_answer$/u);
  await expect(page.locator('[data-discovery-back-to-chat]')).toHaveAttribute('href', '#chat/session/chat_1/answer/message_steps_answer');
});

// D-405 slice 3 — "Not now" on a hint (ruling P3): set aside in its place, with the day it comes back, and
// shown again on request. The server keeps the list (here the fixture's), so a hint set aside elsewhere is
// set aside here too.
test('D-405 slice 3 — "Not now" sets "Add a Passport" aside in place; "Show it again" brings it back', async ({ page }) => {
  const fixes = await open(page);
  await fixes.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(fixes.getByText(/^Not now: “Add a Passport” is hidden until /u)).toBeVisible();
  await expect(fixes.getByRole('link', { name: 'Add a Passport', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window.__chatHintsNotNow ?? []).map((row) => `${row.key} ${row.label}`)))
    .toEqual(['thing:passport Add a Passport']);
  // The offers keep their own.
  await expect(page.locator('[data-chat-install-offers]').getByRole('link', { name: 'Get Rental Book', exact: true })).toBeVisible();
  await fixes.getByRole('button', { name: 'Show it again', exact: true }).click();
  await expect(fixes.getByRole('link', { name: 'Add a Passport', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__chatHintsNotNow ?? [])).toEqual([]);
});

test('D-405 slice 3 — an offer set aside reads so; a hint set aside on another device is set aside here', async ({ page }) => {
  await page.addInitScript(() => {
    window.__chatHintsNotNow = [{ key: 'offer:pack:rental-book', label: 'Get Rental Book', until: Date.now() + 86_400_000 }];
  });
  await open(page);
  const offers = page.locator('[data-chat-install-offers]');
  await expect(offers.getByText(/^Not now: “Get Rental Book” is hidden until /u)).toBeVisible();
  await expect(offers.getByRole('link', { name: 'Get Rental Book', exact: true })).toHaveCount(0);
  await expect(offers.getByRole('link', { name: 'Get Summarize a PDF', exact: true })).toBeVisible();
  await offers.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(offers.getByText(/^Not now: “Get Summarize a PDF” is hidden until /u)).toBeVisible();
});

test('D-405 slice 7 — "Connect your mail" opens Connections with the way back; back at the answer it reads as connected', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?chat=session&chat_steps=mail#chat/session/chat_1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const fixes = page.locator('[data-chat-fixes]');
  await expect(fixes.getByText('No mailbox is connected yet.', { exact: true })).toBeVisible();
  await fixes.getByRole('link', { name: 'Connect your mail', exact: true }).click();
  // The link carries the answer; the page reads it as the mail lane with the way back.
  await expect(page).toHaveURL(/#connections\/mail\/return\/chat\/chat_1\/message_mail_answer$/u);
  const back = page.locator('[data-recued-connections-route-back-to-chat]');
  await expect(back).toHaveText('Back to chat');
  await expect(page.getByRole('button', { name: 'Connect mailbox' })).toBeVisible();
  // A mailbox is connected (the server now says the step landed); the owner goes back.
  await page.evaluate(() => { window.__chatStepsLanded = [{ kind: 'feature', id: 'mail' }]; });
  await back.click();
  await expect(page).toHaveURL(/#chat\/session\/chat_1\/answer\/message_mail_answer$/u);
  const after = page.locator('[data-chat-fixes]');
  await expect(after.getByText('A mailbox is connected now.', { exact: true })).toBeVisible();
  await expect(after.getByRole('link', { name: 'Connect your mail', exact: true })).toHaveCount(0);
  await after.getByRole('button', { name: 'Ask again', exact: true }).click();
  await expect(after.getByText('Asked again.', { exact: true })).toBeVisible();
  expect((await page.evaluate(() => window.__chatStepsSent ?? [])).map((args) => args.message)).toEqual(['What did Anna send me last week?']);
});
