import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installNoteBulkFixture } from './helpers/note-bulk-fixture.js';

installFullAppHooks();
const selection = (page: Page) => page.getByRole('region', { name: 'Note selection', exact: true });
const review = (page: Page) => page.getByRole('region', { name: 'Note link review', exact: true });
const results = (page: Page) => page.getByRole('region', { name: 'Note link results', exact: true });
const outcome = (page: Page, id: string) => results(page).locator(`[data-note-bulk-result="${id}"]`);
const query = (page: Page) => page.locator('[data-action="search-work-entities"][data-kind="note"]');
const boot = async (page: Page) => {
  await page.goto(`${HARNESS_URL}?journey=verification#data/note`); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(selection(page)).toBeVisible();
  await expect(selection(page).getByRole('button', { name: 'Select shown', exact: true })).toBeEnabled();
};
const choose = async (page: Page, kind: 'project' | 'contact') => {
  const input = selection(page).getByRole('combobox', { name: kind === 'project' ? 'Project for selected notes' : 'Contact for selected notes', exact: true });
  await input.fill(kind === 'project' ? 'Target' : 'Riley');
  await selection(page).getByRole('option', { name: kind === 'project' ? /Target <img src=x> project/ : /Riley <img src=x>/ }).click();
};
const preview = async (page: Page, kind: 'project' | 'contact', remove = false) => {
  await choose(page, kind);
  await selection(page).getByRole('button', { name: `Preview ${remove ? 'removing' : 'adding'} ${kind}`, exact: true }).press('Enter');
  await expect(review(page)).toBeFocused(); await expect(review(page).getByRole('status')).not.toHaveText('Checking selected notes…');
};

test('selects only loaded filtered notes, preserves selection on Load more, and excludes read-only and pending notes', async ({ page }) => {
  const f = await installNoteBulkFixture(page, { pageSize: 3, extraNotes: 6 });
  try {
    await boot(page);
    const eligible = await page.locator('.work-entity-note-select input:not(:disabled)').count();
    await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
    await expect(selection(page).getByRole('status')).toHaveText(`${eligible} ${eligible === 1 ? 'note' : 'notes'} selected`);
    const notes = page.locator('.work-entity-note-select input'), initialCount = await notes.count();
    await page.getByRole('button', { name: 'Load more', exact: true }).press('Enter');
    await expect.poll(() => notes.count()).toBeGreaterThan(initialCount);
    await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(eligible);
    for (let i = 0; i < 4 && await page.getByRole('button', { name: 'Load more', exact: true }).isVisible(); i++) {
      const before = await notes.count();
      await page.getByRole('button', { name: 'Load more', exact: true }).press('Enter');
      await expect.poll(() => notes.count()).toBeGreaterThan(before);
    }
    await expect(page.getByRole('checkbox', { name: /^Select Read-only note/ })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: /^Select Pending source note/ })).toBeDisabled();
    await query(page).fill('Capture'); await expect(selection(page).getByRole('status')).toHaveText('0 notes selected');
    await selection(page).getByRole('button', { name: 'Select shown', exact: true }).press('Enter');
    await expect(selection(page).getByRole('status')).toHaveText('2 notes selected');
    await page.getByRole('combobox', { name: 'Data sphere', exact: true }).selectOption('professional');
    await expect(selection(page).getByRole('status')).toHaveText('0 notes selected');
    await page.getByRole('combobox', { name: 'Data sphere', exact: true }).selectOption('all');
    await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
    await page.locator('[data-action="select-source"]').selectOption('readonly.note');
    await expect(selection(page).getByRole('status')).toHaveText('0 notes selected'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('reviews adding project links on a phone and preserves exact note content and other relationships', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); const f = await installNoteBulkFixture(page), original = f.read('a');
  try {
    await boot(page); await query(page).fill('Capture'); await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
    await preview(page, 'project'); await expect(review(page)).toContainText('2 will change'); await expect(review(page).locator('img')).toHaveCount(0);
    expect(f.writes).toEqual([]); expect(f.read('a')).toEqual(original);
    await page.screenshot({ path: testInfo.outputPath('note-link-review-phone.png'), fullPage: true });
    f.failNextList(); await review(page).getByRole('button', { name: 'Apply link changes', exact: true }).press('Enter');
    await expect(results(page).getByRole('status')).toHaveText('2 confirmed · 0 remaining selected'); await expect(results(page)).toBeFocused();
    await expect(outcome(page, 'a')).toHaveAttribute('data-state', 'confirmed');
    expect(f.read('a')).toMatchObject({ body: original.body, title: original.title, related_project_ids: ['launch', 'target'], related_contact_ids: original.related_contact_ids,
      related_calendar_event_ids: ['event'], related_mail_thread_ids: ['thread'] });
    expect(f.writes).toHaveLength(2);
    for (const args of f.writes) { expect(Object.keys(args).sort()).toEqual(['expected_revision', 'id', 'kind', 'related_project_ids']); expect(args.expected_revision).toMatch(/^[a-f0-9]{64}$/); }
    await expect(page.getByRole('alert')).toContainText('refresh was interrupted');
    await results(page).getByRole('button', { name: 'Clear selection', exact: true }).press('Enter');
    await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click(); await preview(page, 'project', true);
    await review(page).getByRole('button', { name: 'Apply link changes', exact: true }).press('Enter');
    await expect(results(page).getByRole('status')).toHaveText('2 confirmed · 0 remaining selected');
    expect(f.read('a').related_project_ids).toEqual(original.related_project_ids); expect(f.read('a').body).toBe(original.body);
  } finally { f.dispose(); }
});

test('adds a contact once, then removes only that contact including legacy aliases', async ({ page }) => {
  const f = await installNoteBulkFixture(page);
  f.change('a', { related_contact_ids: [f.other.contact_id!, f.person.email, f.person.contact_id!] });
  try {
    await boot(page); await query(page).fill('Capture'); await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
    await preview(page, 'contact'); await expect(review(page)).toContainText('1 will change · 1 unchanged or skipped');
    await review(page).getByRole('button', { name: 'Apply link changes', exact: true }).press('Enter');
    await expect(results(page).getByRole('status')).toHaveText('1 confirmed · 0 remaining selected'); expect(f.writes.map(w => w.id)).toEqual(['b']);
    expect(f.read('b').related_contact_ids).toEqual([f.person.contact_id]);
    await results(page).getByRole('button', { name: 'Clear selection', exact: true }).press('Enter');
    await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click(); await preview(page, 'contact', true);
    await review(page).getByRole('button', { name: 'Apply link changes', exact: true }).press('Enter');
    await expect(results(page).getByRole('status')).toHaveText('2 confirmed · 0 remaining selected');
    expect(f.read('a').related_contact_ids).toEqual([f.other.contact_id]); expect(f.read('b').related_contact_ids).toEqual([]);
    expect(f.read('a').related_project_ids).toEqual(['launch']);
  } finally { f.dispose(); }
});

test('retains partial failures and reconciles lost replies without repeating successful writes or taking newer focus', async ({ page }) => {
  const f = await installNoteBulkFixture(page);
  try {
    await boot(page); await query(page).fill('Capture'); await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
    await preview(page, 'project'); f.fail('a', 'lost'); f.fail('b', 'before'); f.hold('work_entity.upsert', 'a');
    await review(page).getByRole('button', { name: 'Apply link changes', exact: true }).press('Enter'); await expect.poll(f.waiting).toBe(true);
    await expect(results(page).getByRole('button', { name: 'Clear selection', exact: true })).toBeDisabled();
    await page.getByRole('combobox', { name: 'Data sphere', exact: true }).selectOption('professional');
    await expect(page.getByRole('combobox', { name: 'Data sphere', exact: true })).toHaveValue('all');
    await query(page).fill('Other query'); await expect(query(page)).toHaveValue('Capture'); await query(page).focus(); f.release();
    await expect(outcome(page, 'a')).toHaveAttribute('data-state', 'failed'); await expect(outcome(page, 'b')).toHaveAttribute('data-state', 'failed'); await expect(query(page)).toBeFocused();
    await results(page).getByRole('button', { name: 'Retry failed', exact: true }).press('Enter');
    await expect(results(page).getByRole('status')).toHaveText('2 confirmed · 0 remaining selected');
    expect(f.writes.filter(w => w.id === 'a')).toHaveLength(1); expect(f.writes.filter(w => w.id === 'b')).toHaveLength(2);
    expect(f.read('a').related_project_ids).toEqual(['launch', 'target']); expect(f.read('b').related_project_ids).toEqual(['launch', 'target']);
  } finally { f.dispose(); }
});

test('requires another review for concurrent note edits, replacements and a reused target project', async ({ page }) => {
  const f = await installNoteBulkFixture(page);
  try {
    await boot(page); await query(page).fill('Capture'); await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click(); await preview(page, 'project');
    f.change('a', { body: 'Peer wording', related_project_ids: ['launch', 'another-project'] }); f.replace('b');
    await review(page).getByRole('button', { name: 'Apply link changes', exact: true }).press('Enter');
    await expect(outcome(page, 'a')).toContainText('changed since review'); await expect(outcome(page, 'b')).toContainText('removed or replaced');
    expect(f.writes).toEqual([]); expect(f.read('a').body).toBe('Peer wording'); expect(f.read('b').body).toBe('Replacement note');
    await results(page).getByRole('button', { name: 'Back to selection', exact: true }).press('Enter');
    await preview(page, 'project'); f.replaceProject(); await review(page).getByRole('button', { name: 'Apply link changes', exact: true }).press('Enter');
    await expect(outcome(page, 'a')).toContainText('changed identity'); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('keeps pending-source outcomes unconfirmed and checks them without another write', async ({ page }) => {
  const f = await installNoteBulkFixture(page);
  try {
    await boot(page); await query(page).fill('Capture Alpha'); await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
    await preview(page, 'project'); f.fail('a', 'pending');
    await review(page).getByRole('button', { name: 'Apply link changes', exact: true }).press('Enter');
    await expect(outcome(page, 'a')).toHaveAttribute('data-state', 'unconfirmed'); await expect(results(page).getByRole('button', { name: 'Retry failed', exact: true })).toHaveCount(0);
    await results(page).getByRole('button', { name: 'Check unconfirmed', exact: true }).press('Enter');
    await expect(outcome(page, 'a')).toHaveAttribute('data-state', 'unconfirmed'); f.confirm('a');
    await results(page).getByRole('button', { name: 'Check unconfirmed', exact: true }).press('Enter');
    await expect(outcome(page, 'a')).toHaveAttribute('data-state', 'confirmed'); expect(f.writes).toHaveLength(1);
  } finally { f.dispose(); }
});

test('retires late review replies on search and refuses an older server without guarded-note support', async ({ page }) => {
  const f = await installNoteBulkFixture(page);
  try {
    await boot(page); await query(page).fill('Capture'); await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click();
    await choose(page, 'project'); f.hold('work_entity.get', 'target');
    const replies = await page.evaluate(() => (window as unknown as { __noteBulkTransport: { settled: string[] } }).__noteBulkTransport.settled.filter(s => s === 'work_entity.get:target').length);
    await selection(page).getByRole('button', { name: 'Preview adding project', exact: true }).press('Enter'); await expect.poll(f.waiting).toBe(true);
    await query(page).fill('Capture Alpha'); f.release();
    await page.waitForFunction(n => (window as unknown as { __noteBulkTransport: { settled: string[] } }).__noteBulkTransport.settled.filter(s => s === 'work_entity.get:target').length > n, replies);
    await expect(review(page)).toHaveCount(0); await expect(selection(page).getByRole('status')).toHaveText('0 notes selected');
    f.revisions(false); await selection(page).getByRole('button', { name: 'Select shown', exact: true }).click(); await preview(page, 'project');
    await expect(review(page)).toContainText('Update the server'); await expect(review(page).getByRole('button', { name: 'Apply link changes', exact: true })).toBeDisabled(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
