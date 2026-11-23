import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installTaskNoteSourceFixture } from './helpers/task-note-source-fixture.js';
import { parseShellRoute, parseSourceRecordAddress, serializeShellRoute, serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks(); test.use({ viewport: { width: 390, height: 900 } });
type Kind = 'mail' | 'calendar' | 'contact';
type Mode = 'ok' | 'deny' | 'hold' | 'legacy' | 'manual';
type Fixture = Awaited<ReturnType<typeof installTaskNoteSourceFixture>>;
declare global { interface Window { __sourceCopy: { copies: string[]; legacy: string[]; mode: Mode; pending: number; settled: number; release(ok: boolean): void } } }
const detail = (page: Page, kind: Kind) => page.locator(kind === 'mail' ? '.data-mail-message' : kind === 'calendar' ? '.calendar-event' : '[data-recued-data-contact-detail]');
const copy = (page: Page, kind: Kind) => detail(page, kind).locator('[data-source-copy-focus="link"]');
const fallback = (page: Page, kind: Kind) => detail(page, kind).locator('[data-source-copy-value]');
const noun = (kind: Kind) => kind === 'mail' ? 'email' : kind === 'calendar' ? 'event' : 'contact';
const route = (page: Page, hash: string) => page.evaluate(hash => window.__app.setHash(hash), hash);
const clipboard = (page: Page, mode: Mode) => page.addInitScript(mode => {
  const state = { copies: [] as string[], legacy: [] as string[], mode, pending: 0, settled: 0,
    release: (_ok: boolean): void => { throw Error('No clipboard request is waiting.'); } };
  window.__sourceCopy = state;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'legacy' || mode === 'manual' ? undefined : {
    writeText: async (value: string) => {
      const current = state.mode; state.copies.push(value);
      try {
        if (current === 'hold') { state.pending++; const ok = await new Promise<boolean>(done => { state.release = done; }); state.pending--; if (!ok) throw Error('Denied'); }
        if (current === 'deny') throw Error('Denied');
      } finally { state.settled++; }
    },
  } });
  document.execCommand = command => {
    if (command !== 'copy') return false;
    state.legacy.push((document.activeElement as HTMLTextAreaElement)?.value ?? ''); return state.mode === 'legacy';
  };
}, mode);
const boot = async (page: Page, mode: Mode = 'ok') => {
  const f = await installTaskNoteSourceFixture(page); await clipboard(page, mode);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple&settle_reads=1&copy_secret=not-for-the-link#data/search`);
  await page.waitForFunction(() => window.__app?.ready === true); return f;
};
const visit = async (page: Page, f: Fixture, kind: Kind, slug = 'work') => {
  await route(page, kind === 'contact' ? serializeShellRoute('data', 'contact', f.person.contact_id!) : serializeSourceRecordAddress(f.source(kind, slug)));
  await expect(detail(page, kind)).toBeVisible(); await expect(copy(page, kind)).toBeVisible();
};
const expected = (f: Fixture, kind: Kind, slug = 'work') => HARNESS_URL.split('?')[0].split('#')[0]
  + (kind === 'contact' ? serializeShellRoute('data', 'contact', f.person.contact_id!) : serializeSourceRecordAddress(f.source(kind, slug)));
const release = async (page: Page, success = false) => {
  const before = await page.evaluate(() => window.__sourceCopy.settled);
  await page.evaluate(success => window.__sourceCopy.release(success), success);
  await page.waitForFunction(before => window.__sourceCopy.settled > before, before);
};
const noWrites = (f: Fixture) => { expect(f.writes).toEqual([]); expect(f.mutations).toEqual([]); };

for (const kind of ['mail', 'calendar', 'contact'] as const) test(`copies an exact ${kind} link, keeps keyboard focus, and opens the current canonical record`, async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, f, kind); await copy(page, kind).focus(); await copy(page, kind).press('Enter');
    await expect(detail(page, kind).locator('.data-source-copy-notice')).toHaveText('Link copied.'); await expect(copy(page, kind)).toBeFocused();
    const values = await page.evaluate(() => window.__sourceCopy.copies); expect(values).toEqual([expected(f, kind)]);
    const link = new URL(values[0]!); expect(link.search).toBe(''); expect(values[0]).not.toContain('copy_secret');
    if (kind === 'contact') expect(parseShellRoute(link.hash).segments).toEqual(['contact', f.person.contact_id]);
    else {
      expect(parseSourceRecordAddress(parseShellRoute(link.hash))).toMatchObject(f.source(kind));
      await visit(page, f, kind, 'home'); await copy(page, kind).click();
      expect(await page.evaluate(() => window.__sourceCopy.copies)).toEqual([expected(f, kind), expected(f, kind, 'home')]);
    }
    if (kind === 'mail') f.updateMail('work', { body: 'The freshly read saved email body.' });
    if (kind === 'calendar') f.updateCalendar('work', { summary: 'Fresh event title' });
    if (kind === 'contact') await f.seedContact(f.person.email, 'Fresh contact title');
    await page.goto(values[0]!); await page.waitForFunction(() => window.__app?.ready === true);
    await expect(detail(page, kind)).toContainText(kind === 'mail' ? 'The freshly read saved email body.' : kind === 'calendar' ? 'Fresh event title' : 'Fresh contact title');
    noWrites(f);
  } finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar', 'contact'] as const) test(`a denied ${kind} copy offers the exact escaped link for manual selection and a successful retry clears it`, async ({ page }, info) => {
  const f = await boot(page, 'deny');
  try {
    await visit(page, f, kind); await copy(page, kind).click();
    const field = detail(page, kind).getByRole('textbox', { name: `Link to this ${noun(kind)}`, exact: true });
    await expect(field).toHaveValue(expected(f, kind)); await expect(field).toHaveAttribute('readonly', ''); await expect(field).toBeFocused();
    expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, expected(f, kind).length]);
    await detail(page, kind).getByRole('button', { name: 'Select link', exact: true }).click(); await expect(field).toBeFocused();
    await expect(detail(page, kind).locator('.data-source-copy-fallback img, .data-source-copy-fallback script')).toHaveCount(0);
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: info.outputPath(`copy-${kind}-manual-phone.png`), fullPage: true });
    await page.evaluate(() => { window.__sourceCopy.mode = 'ok'; }); await copy(page, kind).click();
    await expect(detail(page, kind).locator('.data-source-copy-notice')).toHaveText('Link copied.'); await expect(field).toHaveCount(0); await expect(copy(page, kind)).toBeFocused(); noWrites(f);
  } finally { f.dispose(); }
});

for (const mode of ['legacy', 'manual'] as const) test(`uses the ${mode} fallback when the clipboard API is absent`, async ({ page }) => {
  const f = await boot(page, mode);
  try {
    await visit(page, f, 'mail'); await copy(page, 'mail').focus(); await copy(page, 'mail').press('Enter');
    expect(await page.evaluate(() => window.__sourceCopy.legacy)).toEqual([expected(f, 'mail')]);
    if (mode === 'legacy') { await expect(detail(page, 'mail').locator('.data-source-copy-notice')).toHaveText('Link copied.'); await expect(copy(page, 'mail')).toBeFocused(); }
    else { await expect(fallback(page, 'mail')).toBeFocused(); await expect(fallback(page, 'mail')).toHaveValue(expected(f, 'mail')); }
    noWrites(f);
  } finally { f.dispose(); }
});

test('a delayed old-account clipboard result cannot replace a newer copy for the same provider id', async ({ page }) => {
  const f = await boot(page, 'hold');
  try {
    await visit(page, f, 'mail'); await copy(page, 'mail').click(); await expect.poll(() => page.evaluate(() => window.__sourceCopy.pending)).toBe(1);
    await copy(page, 'mail').evaluate((node: HTMLButtonElement) => node.click()); expect(await page.evaluate(() => window.__sourceCopy.copies)).toHaveLength(1);
    await visit(page, f, 'mail', 'home'); await page.evaluate(() => { window.__sourceCopy.mode = 'ok'; }); await copy(page, 'mail').click();
    await expect(detail(page, 'mail').locator('.data-source-copy-notice')).toHaveText('Link copied.'); await release(page);
    await expect(detail(page, 'mail').locator('.data-source-copy-notice')).toHaveText('Link copied.'); await expect(fallback(page, 'mail')).toHaveCount(0);
    expect(await page.evaluate(() => window.__sourceCopy.copies)).toEqual([expected(f, 'mail'), expected(f, 'mail', 'home')]); noWrites(f);
  } finally { f.dispose(); }
});

test('a delayed contact result cannot steal focus or offer a fallback over an unsaved contact editor', async ({ page }) => {
  const f = await boot(page, 'hold');
  try {
    await visit(page, f, 'contact'); await copy(page, 'contact').click(); await expect.poll(() => page.evaluate(() => window.__sourceCopy.pending)).toBe(1);
    await detail(page, 'contact').getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('[data-recued-data-contact-dialog]'); await expect(editor).toBeVisible();
    const name = editor.getByRole('textbox', { name: /^Name/ }); await name.fill('Keep this unsaved name'); await release(page);
    await expect(name).toBeFocused(); await expect(name).toHaveValue('Keep this unsaved name'); await expect(fallback(page, 'contact')).toHaveCount(0); noWrites(f);
  } finally { f.dispose(); }
});

for (const kind of ['calendar', 'contact'] as const) test(`coordinates ${kind} link copying with existing detail/value copies`, async ({ page }) => {
  const f = await boot(page, 'hold');
  try {
    await visit(page, f, kind); await copy(page, kind).click(); await expect.poll(() => page.evaluate(() => window.__sourceCopy.pending)).toBe(1);
    const other = kind === 'calendar' ? detail(page, kind).getByRole('button', { name: 'Copy event details', exact: true })
      : detail(page, kind).getByRole('button', { name: /^Copy email address:/ }).first();
    await expect(other).toHaveAttribute('aria-disabled', 'true'); await other.evaluate((node: HTMLButtonElement) => node.click());
    expect(await page.evaluate(() => window.__sourceCopy.copies)).toHaveLength(1); await release(page, true);
    await other.click(); await expect.poll(() => page.evaluate(() => window.__sourceCopy.pending)).toBe(1);
    await expect(copy(page, kind)).toHaveAttribute('aria-disabled', 'true'); await copy(page, kind).evaluate((node: HTMLButtonElement) => node.click());
    expect(await page.evaluate(() => window.__sourceCopy.copies)).toHaveLength(2); await release(page, true); await expect(copy(page, kind)).not.toHaveAttribute('aria-disabled', 'true'); noWrites(f);
  } finally { f.dispose(); }
});

test('copying an email link preserves the current Find query, selected match and reader scroll', async ({ page }) => {
  const f = await boot(page);
  try {
    f.updateMail('work', { body: Array.from({ length: 30 }, (_, index) => `Needle ${index + 1}. ${'Keep the saved email text readable. '.repeat(4)}`).join('\n\n') });
    await visit(page, f, 'mail'); await detail(page, 'mail').getByRole('button', { name: 'Find in email', exact: true }).click();
    const find = page.locator('.data-mail-conversation').getByRole('searchbox', { name: 'Find in this email', exact: true }); await find.fill('Needle'); await find.press('Enter'); await find.press('Enter');
    await expect(page.locator('[data-mail-find-status]')).toHaveText('3 of 30 matches.');
    const host = page.locator('[data-recued-webclient-content]'); await host.evaluate(node => { node.scrollTop = 50; });
    await copy(page, 'mail').evaluate(node => node.focus({ preventScroll: true })); const top = await host.evaluate(node => node.scrollTop);
    await copy(page, 'mail').press('Enter'); await expect(detail(page, 'mail').locator('.data-source-copy-notice')).toHaveText('Link copied.');
    await expect(find).toHaveValue('Needle'); await expect(page.locator('[data-mail-find-status]')).toHaveText('3 of 30 matches.');
    expect(await host.evaluate(node => node.scrollTop)).toBeCloseTo(top, -1); await expect(copy(page, 'mail')).toBeFocused(); noWrites(f);
  } finally { f.dispose(); }
});

test('a background contact history failure preserves the manual link selection', async ({ page }) => {
  const f = await boot(page, 'deny');
  try {
    f.hold('yours.read', ''); f.fail('yours.read', ''); await visit(page, f, 'contact'); await expect.poll(f.waiting).toBe(true); await copy(page, 'contact').click();
    const field = fallback(page, 'contact'); await expect(field).toBeFocused(); await field.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 8, 'backward'));
    const before = await page.evaluate(() => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'yours.read:').length);
    f.release(); await page.waitForFunction(before => (window as unknown as { __taskReaderSettled: string[] }).__taskReaderSettled.filter(value => value === 'yours.read:').length > before, before);
    await expect(detail(page, 'contact')).toContainText('This history could not be read.');
    await expect(field).toBeFocused(); expect(await field.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([2, 8, 'backward']); noWrites(f);
  } finally { f.dispose(); }
});

for (const kind of ['mail', 'calendar'] as const) test(`a copied ${kind} link works as an exact source reference in a saved note`, async ({ page }) => {
  const f = await boot(page);
  try {
    await visit(page, f, kind); await copy(page, kind).click(); await expect(detail(page, kind).locator('.data-source-copy-notice')).toHaveText('Link copied.');
    const value = (await page.evaluate(() => window.__sourceCopy.copies))[0]!; f.seedNote('link-note', { title: 'Source reference', body: `Saved source: ${value}` });
    await route(page, '#data/note/link-note'); const reader = page.locator('.work-entity-note-reader'); await expect(reader).toBeVisible();
    await reader.locator('a[data-note-note-link]').click(); await expect(detail(page, kind)).toBeVisible();
    await expect(page).toHaveURL(new RegExp('#' + value.split('#')[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
    await page.getByRole('button', { name: 'Back to note', exact: true }).click(); await expect(reader).toHaveAttribute('data-note-id', 'link-note'); noWrites(f);
  } finally { f.dispose(); }
});
