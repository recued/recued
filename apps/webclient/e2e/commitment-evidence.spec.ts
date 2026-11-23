import { expect, test, type Page } from '@playwright/test';
import type { CommitmentEvidenceEntry } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installCommitmentFollowUpFixture } from './helpers/commitment-follow-up-fixture.js';

installFullAppHooks();
test.use({ timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installCommitmentFollowUpFixture>>;
const captured = Date.parse('2026-11-20T20:00:00Z'), sourceAt = captured - 86_400_000;
const evidence: readonly CommitmentEvidenceEntry[] = [
  { kind: 'mail', full_target_id: 'mail/source', source: 'mail', actor_email: 'riley@example.test', source_at: sourceAt,
    captured_at: captured, confidence: .8, snippet: 'Riley will send the proposal <team>.', vendor_url: 'https://evidence.example.test/email?a=1&b=2#promise' },
  { kind: 'message', full_target_id: 'slack/message', vendor: 'slack', actor_platform_id: 'person', captured_at: captured,
    sent_at: sourceAt - 1000, snippet: 'I will send it tomorrow.\nKeep the <team> details.' },
  { kind: 'crm_field', full_target_id: 'crm/deal', captured_at: captured, field: 'next_step', prev_value: 'Call tomorrow', value: 'Send the proposal' },
  { kind: 'message', full_target_id: 'slack/summary', vendor: 'slack', actor_platform_id: 'person', captured_at: captured,
    sent_at: sourceAt, snippet: 'Riley plans to send a proposal.', confidence: .9 },
];
const reader = (page: Page) => page.locator('.work-entity-commitment-reader');
const panel = (page: Page) => reader(page).locator('[data-commitment-section="evidence"]');
const summary = (page: Page) => panel(page).locator('summary');
const entries = (page: Page) => panel(page).locator('[data-commitment-evidence-entry]');
const content = (page: Page) => reader(page).locator('.work-entity-commitment-content');
const boot = async (page: Page, prepare?: (f: Fixture) => void, samples = evidence) => {
  const f = await installCommitmentFollowUpFixture(page);
  if (samples.length) f.change({ derivation: 'evidence_captured', evidence_blob: samples });
  prepare?.(f);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple#data/commitment/promise-one`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(reader(page)).toContainText('Send the revised proposal <team>'); return f;
};
const expand = async (page: Page) => { await summary(page).focus(); await summary(page).press('Enter'); await expect(panel(page)).toHaveAttribute('open', ''); };

test('shows source facts and their dates without presenting an AI paraphrase as a quotation', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); const f = await boot(page);
  try {
    await expand(page); await expect(entries(page)).toHaveCount(4);
    const mail = entries(page).nth(0), message = entries(page).nth(1), crm = entries(page).nth(2), summarizedMessage = entries(page).nth(3);
    await expect(mail.getByRole('heading', { name: 'Email summary', exact: true })).toBeVisible();
    await expect(mail).toContainText('AI-generated summary, not a verbatim quotation.'); await expect(mail.locator('blockquote')).toHaveCount(0);
    await expect(mail).toContainText('Riley will send the proposal <team>.');
    await expect(mail.locator('time').first()).toHaveAttribute('datetime', '2026-11-19T20:00:00.000Z');
    await expect(mail.locator('time').last()).toHaveAttribute('datetime', '2026-11-20T20:00:00.000Z');
    await expect(message.locator('blockquote')).toHaveText('I will send it tomorrow.\nKeep the <team> details.');
    await expect(message.locator('time').first()).toHaveAttribute('datetime', '2026-11-19T19:59:59.000Z');
    await expect(crm).toContainText('Previous valueCall tomorrow'); await expect(crm).toContainText('Captured valueSend the proposal');
    await expect(crm.locator('time')).toHaveCount(1);
    await expect(summarizedMessage.getByRole('heading', { name: 'Message summary', exact: true })).toBeVisible();
    await expect(summarizedMessage.locator('blockquote')).toHaveCount(0);
    await expect(panel(page).locator('img,iframe,script')).toHaveCount(0); expect(f.writes).toEqual([]); expect(f.executions).toEqual([]);
    await page.screenshot({ path: info.outputPath('commitment-evidence-phone.png'), fullPage: true });
  } finally { f.dispose(); }
});

test('opens a captured source without leaving the exact commitment or losing its reading position', async ({ page }) => {
  const f = await boot(page);
  try {
    await page.context().route('https://evidence.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Original source</h1>' }));
    await expand(page);
    const link = entries(page).first().getByRole('link', { name: 'Open source (new tab)', exact: true });
    await link.focus(); const hash = await page.evaluate(() => location.hash), position = await content(page).evaluate(el => el.scrollTop);
    const opened = page.context().waitForEvent('page'); await link.press('Enter'); const source = await opened;
    await expect(source.getByRole('heading', { name: 'Original source', exact: true })).toBeVisible();
    expect(source.url()).toBe('https://evidence.example.test/email?a=1&b=2#promise');
    expect(await source.evaluate(() => window.opener === null)).toBe(true); await source.close(); await page.bringToFront();
    expect(await page.evaluate(() => location.hash)).toBe(hash); await expect(reader(page)).toHaveAttribute('data-commitment-id', 'promise-one');
    await expect(panel(page)).toHaveAttribute('open', ''); await expect(link).toBeFocused();
    expect(Math.abs((await content(page).evaluate(el => el.scrollTop)) - position)).toBeLessThan(2);
    expect(f.writes).toEqual([]); expect(f.executions).toEqual([]);
  } finally { f.dispose(); }
});

for (const focusTarget of ['source link', 'summary'] as const) {
  test(`preserves the evidence disclosure and focused ${focusTarget} when a delayed contact read repaints the reader`, async ({ page }) => {
    const f = await boot(page, f => f.hold('contact.get'));
    try {
      await expect.poll(() => f.waiting('contact.get')).toBe(true); await expand(page);
      const link = focusTarget === 'source link' ? entries(page).first().getByRole('link') : summary(page); await link.focus();
      const position = await content(page).evaluate(el => el.scrollTop);
      f.release('contact.get'); await expect(reader(page).getByRole('button', { name: 'Draft follow-up', exact: true })).toBeEnabled();
      await expect(panel(page)).toHaveAttribute('open', ''); await expect(link).toBeFocused();
      expect(Math.abs((await content(page).evaluate(el => el.scrollTop)) - position)).toBeLessThan(2);
      expect(f.writes).toEqual([]); expect(f.executions).toEqual([]);
    } finally { f.dispose(); }
  });
}

test('keeps saved evidence through an edit and AI follow-up, then resets the panel for another promise', async ({ page }) => {
  const f = await boot(page, f => { f.seed('promise-two', { statement: 'A second promise' }); });
  try {
    await expand(page); await reader(page).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.locator('.work-entity-dialog[data-kind="commitment"][data-mode="edit"]');
    await editor.locator('[data-form-field="statement"]').fill('Send the final proposal');
    await editor.getByRole('button', { name: 'Save', exact: true }).click(); await expect(reader(page)).toContainText('Commitment saved.');
    await expect(panel(page)).toHaveAttribute('open', ''); await expect(entries(page).first()).toContainText('Riley will send the proposal <team>.');
    await reader(page).getByRole('button', { name: 'Draft follow-up', exact: true }).click();
    const mail = page.getByRole('dialog', { name: 'New mail', exact: true });
    await expect(mail.getByRole('textbox', { name: 'What should this email say?', exact: true })).toBeFocused();
    await mail.getByRole('button', { name: 'Close', exact: true }).click(); await mail.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await expect(mail).toHaveCount(0); await expect(panel(page)).toHaveAttribute('open', '');
    await reader(page).getByRole('button', { name: 'Back to commitments', exact: true }).click();
    await page.evaluate(() => window.__app.setHash('#data/commitment/promise-two'));
    await expect(reader(page)).toHaveAttribute('data-commitment-id', 'promise-two'); await expect(panel(page)).not.toHaveAttribute('open', '');
    expect(f.writes).toEqual(['work_entity.upsert']); expect(f.executions).toEqual([]);
  } finally { f.dispose(); }
});

test('explains a missing source link and renders hostile captured text as plain text', async ({ page }) => {
  const f = await boot(page, undefined, [{ ...evidence[0]!, vendor_url: 'javascript:alert(1)',
    snippet: '<img src="https://unwanted.test/tracker" onerror="alert(1)">' } as CommitmentEvidenceEntry]);
  try {
    await expand(page); await expect(panel(page)).toContainText('No source link is available.'); await expect(panel(page).getByRole('link')).toHaveCount(0);
    await expect(panel(page)).toContainText('<img src="https://unwanted.test/tracker" onerror="alert(1)">');
    await expect(panel(page).locator('img,iframe,script')).toHaveCount(0); expect(f.writes).toEqual([]); expect(f.executions).toEqual([]);
  } finally { f.dispose(); }
});

test('keeps a promise readable when no evidence snapshot was captured', async ({ page }) => {
  const f = await boot(page, undefined, []);
  try {
    await expand(page); await expect(panel(page)).toContainText('No captured source evidence is available for this commitment.');
    await expect(entries(page)).toHaveCount(0); await expect(reader(page).getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
    expect(f.writes).toEqual([]); expect(f.executions).toEqual([]);
  } finally { f.dispose(); }
});
