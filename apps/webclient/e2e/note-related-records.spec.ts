import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installNoteRelatedFixture } from './helpers/note-related-records-fixture.js';

installFullAppHooks();
const reader = (page: Page) => page.locator('.work-entity-note-reader');
const related = (page: Page) => reader(page).locator('[data-note-section="related"]');
const contactLink = (page: Page) => related(page).getByRole('button', { name: 'Open contact Riley <img src=x>', exact: true });
const projectLink = (page: Page) => related(page).getByRole('button', { name: 'Open project Launch <img src=x> project', exact: true });
const boot = async (page: Page, missing = false, hash = '#data/note/note-one', mail = false) => {
  const fixture = await installNoteRelatedFixture(page, missing);
  if (missing) { fixture.fail('contact.get', 'failed@example.test'); fixture.fail('work_entity.get', 'failed-project'); }
  const query = mail ? 'data=contacts&settle_reads=1&connection=source-answer' : 'journey=verification&server_profiles=multiple';
  await page.goto(`${HARNESS_URL}?${query}${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  return fixture;
};
const expand = async (page: Page) => {
  await related(page).locator('summary').click(); await expect(contactLink(page)).toBeVisible(); await expect(projectLink(page)).toBeVisible();
};

test('loads names on expansion and returns from the exact contact with format, Find match, sections, scroll and focus intact', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 }); const fixture = await boot(page);
  try {
    await expect(reader(page).getByRole('heading', { name: 'Linked note', exact: true })).toBeVisible();
    expect(fixture.reads.filter(read => read.method === 'contact.get' || read.id.startsWith('project-'))).toEqual([]);
    await reader(page).getByRole('button', { name: 'Formatted', exact: true }).click();
    await reader(page).getByRole('button', { name: 'Find in note', exact: true }).click();
    await reader(page).getByRole('searchbox', { name: 'Find in this note', exact: true }).fill('Marker café');
    await reader(page).getByRole('button', { name: 'Next match', exact: true }).click(); await reader(page).getByRole('button', { name: 'Next match', exact: true }).click();
    await expect(reader(page).locator('[data-note-find-status]')).toHaveText('3 of 30 matches.');
    await expand(page); await expect(related(page).locator('img,script')).toHaveCount(0);
    await contactLink(page).scrollIntoViewIfNeeded(); const top = await reader(page).locator('.work-entity-note-content').evaluate(node => node.scrollTop);
    await page.screenshot({ path: testInfo.outputPath('note-related-phone.png'), fullPage: true });
    await contactLink(page).click(); await expect(page).toHaveURL(/#data\/contact\/riley%40example\.test$/);
    await page.getByRole('button', { name: '← Back to note', exact: true }).click();
    await expect(reader(page)).toHaveAttribute('data-note-format', 'formatted'); await expect(contactLink(page)).toBeFocused();
    await expect(reader(page).getByRole('searchbox', { name: 'Find in this note', exact: true })).toHaveValue('Marker café');
    await expect(reader(page).locator('[data-note-find-status]')).toHaveText('3 of 30 matches.');
    await expect(related(page)).toHaveAttribute('open', '');
    expect(Math.abs(await reader(page).locator('.work-entity-note-content').evaluate(node => node.scrollTop) - top)).toBeLessThanOrEqual(1);
    expect(fixture.writes).toEqual([]); expect(fixture.readNote()).toEqual(fixture.original);
  } finally { fixture.dispose(); }
});

test('opens the exact project by keyboard and browser Back restores the note without remounting its reader state', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await reader(page).getByRole('button', { name: 'Formatted', exact: true }).click(); await expand(page);
    await projectLink(page).focus(); await projectLink(page).press('Enter');
    await expect(page.locator('[data-project-overview="project-one"]')).toBeVisible(); await expect(page).toHaveURL(/#data\/project\/project-one$/);
    await page.goBack(); await expect(reader(page)).toHaveAttribute('data-note-id', 'note-one');
    await expect(reader(page)).toHaveAttribute('data-note-format', 'formatted'); await expect(projectLink(page)).toBeFocused();
    expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('browser Back protects email drafted from a related contact before returning to the note', async ({ page }) => {
  const fixture = await boot(page, false, '#data/note/note-one', true);
  try {
    await expand(page); await contactLink(page).click();
    const contact = page.locator('[data-recued-data-contact-detail]');
    await contact.getByRole('button', { name: 'Draft email', exact: true }).click();
    const compose = page.getByRole('dialog', { name: 'New mail', exact: true });
    await compose.locator('[data-form-field="body"]').fill('Keep this unfinished message.');
    const hash = await page.evaluate(() => location.hash), prompts: string[] = [];
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); });
    await page.goBack(); await expect.poll(() => prompts.length).toBe(1);
    await expect(page).toHaveURL(new RegExp(hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
    await expect(compose.locator('[data-form-field="body"]')).toHaveValue('Keep this unfinished message.');
    page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.accept(); });
    await page.goBack(); await expect.poll(() => prompts.length).toBe(2);
    await expect(compose).toHaveCount(0); await expect(reader(page)).toHaveAttribute('data-note-id', 'note-one');
    await expect(contactLink(page)).toBeFocused(); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('keeps the note return through a project edit and explicit discard', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await expand(page); await projectLink(page).click();
    const project = page.locator('[data-project-overview="project-one"]');
    await project.getByRole('button', { name: 'Edit project', exact: true }).click();
    const editor = page.locator('.work-entity-dialog[data-kind="project"]');
    await editor.locator('[data-form-field="title"]').fill('Unsaved project changes');
    await editor.getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible(); await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await project.getByRole('button', { name: 'Back to note', exact: true }).click();
    await expect(projectLink(page)).toBeFocused(); expect(fixture.writes).toEqual([]); expect(fixture.readNote()).toEqual(fixture.original);
  } finally { fixture.dispose(); }
});

test('shows independent missing and unavailable records and retries only the failed relationship', async ({ page }) => {
  const fixture = await boot(page, true);
  try {
    await expand(page); await expect(related(page)).toContainText('This contact is no longer available.');
    await expect(related(page)).toContainText('This project is no longer available.');
    await expect(related(page)).toContainText('Could not load this contact.'); await expect(related(page)).toContainText('Could not load this project.');
    const readyReads = fixture.reads.filter(read => read.id === 'project-one').length;
    fixture.fail('work_entity.get', 'failed-project', false);
    await related(page).locator('[data-action="retry-note-related"][data-note-related-key="project:failed-project"]').click();
    await expect(related(page).getByRole('button', { name: 'Open project Recovered project', exact: true })).toBeVisible();
    expect(fixture.reads.filter(read => read.id === 'project-one')).toHaveLength(readyReads);
    fixture.fail('contact.get', 'failed@example.test', false);
    await related(page).locator('[data-action="retry-note-related"][data-note-related-key="contact:failed@example.test"]').click();
    await expect(related(page).getByRole('button', { name: 'Open contact Recovered contact', exact: true })).toBeVisible();
    expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

for (const change of ['delete', 'replace'] as const) {
  test(`a ${change} after label loading is checked before leaving the note`, async ({ page }) => {
    const fixture = await boot(page);
    try {
      await expand(page); if (change === 'delete') fixture.deleteProject('project-one'); else fixture.replaceProject();
      await projectLink(page).click();
      await expect(related(page)).toContainText(change === 'delete' ? 'This project is no longer available.' : 'Could not load this project.');
      await expect(page).toHaveURL(/#data\/note\/note-one$/); await expect(page.locator('[data-project-overview]')).toHaveCount(0);
      expect(fixture.writes).toEqual([]); expect(fixture.readNote()).toEqual(fixture.original);
    } finally { fixture.dispose(); }
  });
}

for (const phase of ['labels', 'open'] as const) {
  test(`ignores a late ${phase} read after a different note takes ownership`, async ({ page }) => {
    const fixture = await boot(page);
    try {
      if (phase === 'open') await expand(page);
      fixture.hold('work_entity.get', 'project-one');
      if (phase === 'open') await projectLink(page).click(); else await related(page).locator('summary').click();
      await expect.poll(fixture.pending).toBe(true);
      await page.evaluate(() => window.__app.setHash('#data/note/note-other'));
      await expect(reader(page)).toHaveAttribute('data-note-id', 'note-other'); fixture.release();
      await related(page).locator('summary').click();
      await expect(related(page).getByRole('button', { name: 'Open project Second project', exact: true })).toBeVisible();
      await expect(related(page)).not.toContainText('Launch'); await expect(page).toHaveURL(/#data\/note\/note-other$/);
      expect(fixture.writes).toEqual([]);
    } finally { fixture.dispose(); }
  });
}

test('returns through the original project after visiting a different project from its note', async ({ page }) => {
  const fixture = await boot(page, false, '#data/project/project-two');
  try {
    const originalProject = page.locator('[data-project-overview="project-two"]');
    await originalProject.locator('[data-project-item-id="note-one"]').click(); await expand(page); await projectLink(page).click();
    await page.locator('[data-project-overview="project-one"]').getByRole('button', { name: 'Back to note', exact: true }).click();
    await expect(projectLink(page)).toBeFocused(); await reader(page).getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(originalProject).toBeVisible(); await expect(originalProject.locator('[data-project-item-id="note-one"]')).toBeFocused();
    expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('retains Back to original after opening a project from a duplicated note', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await reader(page).getByRole('button', { name: 'Duplicate note', exact: true }).click();
    const editor = page.locator('.work-entity-dialog[data-kind="note"]'); await editor.getByRole('button', { name: 'Save', exact: true }).click();
    const copyId = await reader(page).getAttribute('data-note-id'); expect(copyId).not.toBe('note-one');
    await expand(page); await projectLink(page).click();
    await page.locator('[data-project-overview="project-one"]').getByRole('button', { name: 'Back to note', exact: true }).click();
    await expect(reader(page)).toHaveAttribute('data-note-id', copyId!);
    await reader(page).getByRole('button', { name: 'Back to original note', exact: true }).click();
    await expect(reader(page)).toHaveAttribute('data-note-id', 'note-one'); expect(fixture.writes).toHaveLength(1);
  } finally { fixture.dispose(); }
});

test('keeps the original universal search after returning through the note', async ({ page }) => {
  const fixture = await boot(page, false, '#data/search');
  try {
    const query = page.locator('[data-recued-universal-search-input]'); await query.fill('Linked note'); await query.press('Enter');
    const result = page.locator('[data-work-search-group="note"] [data-search-work-id="note-one"]');
    await result.click(); await expand(page); await projectLink(page).click();
    await page.locator('[data-project-overview="project-one"]').getByRole('button', { name: 'Back to note', exact: true }).click();
    await reader(page).getByRole('button', { name: 'Back to search', exact: true }).click();
    await expect(query).toHaveValue('Linked note'); await expect(result).toBeFocused(); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});

test('keeps separate note returns when a related project leads to another note visit', async ({ page }) => {
  const fixture = await boot(page);
  try {
    await expand(page); await projectLink(page).click();
    const project = page.locator('[data-project-overview="project-one"]'); await project.locator('[data-project-item-id="note-one"]').click();
    // This fresh visit to the same note resumes its expanded Related records section.
    await expect(related(page)).toHaveAttribute('open', '');
    await expect(contactLink(page)).toBeVisible();
    await related(page).getByRole('button', { name: 'Open project Second project', exact: true }).click();
    await page.locator('[data-project-overview="project-two"]').getByRole('button', { name: 'Back to note', exact: true }).click();
    await reader(page).getByRole('button', { name: 'Back to project', exact: true }).click();
    await project.getByRole('button', { name: 'Back to note', exact: true }).click();
    await expect(reader(page).getByRole('button', { name: 'Back to notes', exact: true })).toBeVisible(); expect(fixture.writes).toEqual([]);
  } finally { fixture.dispose(); }
});
