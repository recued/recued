import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installCommitmentRelatedFixture } from './helpers/commitment-related-fixture.js';

installFullAppHooks();
test.use({ timezoneId: 'America/Los_Angeles' });
type Fixture = Awaited<ReturnType<typeof installCommitmentRelatedFixture>>;
const reader = (page: Page) => page.locator('.work-entity-commitment-reader');
const panel = (page: Page) => reader(page).locator('[data-commitment-section="related"]');
const row = (page: Page, key: string) => panel(page).locator('[data-commitment-related-row]').filter({ has: page.locator(`[data-commitment-related-key="${key}"]`) });
const button = (page: Page, key: string, action: 'open' | 'preview' = 'open') => row(page, key).locator(`[data-action="${action}-commitment-related"]`);
const boot = async (page: Page, prepare?: (f: Fixture) => void, hash = '#data/commitment/promise-one') => {
  const f = await installCommitmentRelatedFixture(page); prepare?.(f);
  await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple&settle_reads=1${hash}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (hash.startsWith('#data/commitment/')) await expect(reader(page)).toHaveAttribute('data-commitment-id', 'promise-one'); return f;
};
const expand = async (page: Page) => { await panel(page).locator('summary').click(); await expect(panel(page)).toHaveAttribute('open', ''); };
const preview = async (page: Page, key: string, kind: 'Contact' | 'Project' | 'Task') => {
  await button(page, key, 'preview').click(); const region = row(page, key).getByRole('region', { name: `${kind} preview`, exact: true });
  await expect(region.locator('dl')).toBeVisible(); return region;
};

test('loads linked names lazily and previews saved contact, task and project details without changing the promise', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); const f = await boot(page);
  try {
    expect(f.reads.filter(read => read.method === 'work_entity.get' && (read.kind === 'task' || read.kind === 'project'))).toEqual([]);
    await expand(page); const contact = await preview(page, `contact:${f.person.contact_id}`, 'Contact');
    await expect(contact).toContainText('riley@example.test'); await expect(contact).toContainText('Example Co');
    await expect(contact.locator('img,script')).toHaveCount(0);
    await contact.getByRole('button', { name: 'Close preview', exact: true }).press('Escape'); await expect(contact).toHaveCount(0);
    await expect(button(page, `contact:${f.person.contact_id}`, 'preview')).toBeFocused(); await expect(reader(page)).toBeVisible();
    const project = await preview(page, 'project:project-one', 'Project'); await expect(project).toContainText('Keep the original launch scope.');
    const task = await preview(page, 'task:task-one', 'Task'); await expect(task).toContainText('Saved statusOpen'); await expect(task).toContainText('Keep these task notes.');
    await expect(row(page, 'task:task-two')).toContainText('Saved status: Completed');
    await page.screenshot({ path: info.outputPath('commitment-related-phone.png'), fullPage: true });
    expect(f.saved()).toEqual(f.original); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['contact', 'project', 'task'] as const) {
  test(`opens a linked ${kind} and returns to the same commitment, preview, scroll position and control`, async ({ page }) => {
    const f = await boot(page);
    try {
      const key = kind === 'contact' ? `contact:${f.person.contact_id}` : `${kind}:${kind}-one`;
      await reader(page).locator('[data-commitment-section="evidence"] summary').click(); await expand(page);
      await preview(page, key, kind === 'contact' ? 'Contact' : kind === 'project' ? 'Project' : 'Task');
      const open = button(page, key); await open.focus();
      const hash = await page.evaluate(() => location.hash), top = await reader(page).locator('.work-entity-commitment-content').evaluate(el => el.scrollTop);
      await open.press('Enter'); await expect(reader(page)).toHaveCount(0);
      if (kind === 'contact') await expect(page.locator('[data-recued-data-contact-detail]')).toContainText('Riley <team>');
      else if (kind === 'project') await expect(page.locator('[data-project-overview="project-one"]')).toBeVisible();
      else await expect(page.locator('.work-entity-task-reader')).toContainText('Review the proposal');
      if (kind === 'task') await page.goBack(); else await page.getByRole('button', { name: /Back to commitment/ }).click();
      await expect(reader(page)).toHaveAttribute('data-commitment-id', 'promise-one'); await expect(open).toBeFocused();
      expect(await page.evaluate(() => location.hash)).toBe(hash); await expect(panel(page)).toHaveAttribute('open', '');
      await expect(reader(page).locator('[data-commitment-section="evidence"]')).toHaveAttribute('open', '');
      await expect(row(page, key).getByRole('region')).toBeVisible();
      expect(Math.abs((await reader(page).locator('.work-entity-commitment-content').evaluate(el => el.scrollTop)) - top)).toBeLessThan(3);
      expect(f.saved()).toEqual(f.original); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });
}

test('refreshes a task title changed during a child visit without rewriting the commitment links', async ({ page }) => {
  const f = await boot(page);
  try {
    await expand(page); await button(page, 'task:task-one').click(); await expect(page.locator('.work-entity-task-reader')).toBeVisible();
    f.renameTask('A title changed elsewhere'); await page.getByRole('button', { name: 'Back to commitment', exact: true }).click();
    await expect(button(page, 'task:task-one')).toHaveAccessibleName('Open task A title changed elsewhere');
    await expect(button(page, 'task:task-one')).toBeFocused(); expect(f.saved()).toEqual(f.original); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('reports missing links, retries them, and refuses a project replaced after its label was read', async ({ page }) => {
  const f = await boot(page, f => f.deleteTask());
  try {
    await expand(page); await expect(row(page, 'task:task-one')).toContainText('no longer available');
    f.restoreTask(); await row(page, 'task:task-one').getByRole('button', { name: /Try/ }).click();
    await expect(button(page, 'task:task-one')).toHaveAccessibleName('Open task Recovered task');
    await expect(button(page, 'project:project-one')).toBeEnabled(); f.replaceProject(); await button(page, 'project:project-one').click();
    await expect(row(page, 'project:project-one')).toContainText('Could not load this project');
    await expect(reader(page)).toBeVisible(); await expect(page.locator('[data-project-overview]')).toHaveCount(0); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const action of ['preview', 'open'] as const) {
  test(`retires a delayed ${action} when another commitment opens`, async ({ page }) => {
    const f = await boot(page);
    try {
      await expand(page); await expect(button(page, 'project:project-one')).toBeEnabled(); f.hold('work_entity.get', 'project-one');
      await button(page, 'project:project-one', action).click(); await expect.poll(f.pending).toBe(true);
      await page.evaluate(() => window.__app.setHash('#data/commitment/promise-two')); await expect(reader(page)).toHaveAttribute('data-commitment-id', 'promise-two');
      f.release(); await expect(panel(page)).not.toHaveAttribute('open', '');
      await expect(page.locator('[data-project-overview]')).toHaveCount(0); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });
}

test('keeps an existing mail draft and its commitment in place when a linked-record navigation is declined', async ({ page }) => {
  const f = await boot(page);
  try {
    await expand(page); await expect(button(page, 'project:project-one')).toBeEnabled();
    await reader(page).getByRole('button', { name: 'Draft follow-up', exact: true }).click();
    const mail = page.getByRole('dialog', { name: 'New mail', exact: true }); await mail.locator('[data-form-field="body"]').fill('Keep this unfinished draft.');
    const projectReads = f.reads.filter(read => read.method === 'work_entity.get' && read.id === 'project-one').length;
    const hash = await page.evaluate(() => location.hash);
    await button(page, 'project:project-one').evaluate(node => (node as HTMLButtonElement).click());
    await expect(mail.getByRole('textbox', { name: 'What should this email say?', exact: true })).toBeFocused();
    await expect(mail.locator('[data-form-field="body"]')).toHaveValue('Keep this unfinished draft.');
    expect(await page.evaluate(() => location.hash)).toBe(hash);
    expect(f.reads.filter(read => read.method === 'work_entity.get' && read.id === 'project-one')).toHaveLength(projectReads);
    await expect(reader(page)).toHaveAttribute('data-commitment-id', 'promise-one'); await expect(page.locator('[data-project-overview]')).toHaveCount(0);
    await mail.getByRole('button', { name: 'Close', exact: true }).click(); await mail.getByRole('button', { name: 'Discard draft', exact: true }).click();
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('loads a bounded page of links and offers the rest explicitly', async ({ page }) => {
  const f = await boot(page, f => f.seedProjects(25));
  try {
    await expand(page); await expect(panel(page).locator('[data-commitment-related-row]')).toHaveCount(20);
    await expect(button(page, 'project:paged-18')).toBeEnabled();
    expect(f.reads.filter(read => read.method === 'work_entity.get' && read.kind === 'project')).toHaveLength(19);
    await panel(page).getByRole('button', { name: 'More related records', exact: true }).click();
    await expect(panel(page).locator('[data-commitment-related-row]')).toHaveCount(28); await expect(button(page, 'project:paged-24')).toBeEnabled();
    await expect(button(page, 'task:task-one')).toBeEnabled(); await expect(row(page, 'project:paged-19').getByRole('heading')).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

for (const kind of ['contact', 'project'] as const) {
  test(`browser Back protects an unsaved ${kind} edit before returning to the commitment`, async ({ page }) => {
    const f = await boot(page);
    try {
      await expand(page); await button(page, kind === 'contact' ? `contact:${f.person.contact_id}` : 'project:project-one').click();
      if (kind === 'contact') await page.locator('[data-recued-data-contact-detail]').getByRole('button', { name: 'Edit', exact: true }).click();
      else await page.locator('[data-project-overview]').getByRole('button', { name: 'Edit project', exact: true }).click();
      const input = kind === 'contact' ? page.getByRole('dialog', { name: 'Edit contact', exact: true }).getByLabel('Name', { exact: true })
        : page.locator('.work-entity-dialog[data-kind="project"] [data-form-field="title"]');
      await input.fill('Unfinished child edit');
      const hash = await page.evaluate(() => location.hash), prompts: string[] = [];
      page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.dismiss(); }); await page.goBack();
      await expect.poll(() => prompts.length).toBe(1); expect(await page.evaluate(() => location.hash)).toBe(hash); await expect(input).toHaveValue('Unfinished child edit');
      page.once('dialog', dialog => { prompts.push(dialog.message()); void dialog.accept(); }); await page.goBack();
      await expect.poll(() => prompts.length).toBe(2); await expect(reader(page)).toHaveAttribute('data-commitment-id', 'promise-one');
      await expect(button(page, kind === 'contact' ? `contact:${f.person.contact_id}` : 'project:project-one')).toBeFocused();
      expect(f.saved()).toEqual(f.original); expect(f.writes).toEqual([]);
    } finally { f.dispose(); }
  });
}

test('preserves a project entry point through a visit to another project from its commitment', async ({ page }) => {
  const f = await boot(page, f => { f.seedProject('project-other'); f.patch({ blocks_project_ids: ['project-one', 'project-other'] }); }, '#data/project/project-one');
  try {
    const original = page.locator('[data-project-overview="project-one"]'); await original.locator('[data-project-item-id="promise-one"]').click();
    await expand(page); await button(page, 'project:project-other').click();
    await page.locator('[data-project-overview="project-other"]').getByRole('button', { name: 'Back to commitment', exact: true }).click();
    await expect(button(page, 'project:project-other')).toBeFocused(); await reader(page).getByRole('button', { name: 'Back to project', exact: true }).click();
    await expect(original).toBeVisible(); await expect(original.locator('[data-project-item-id="promise-one"]')).toBeFocused(); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('leaves a new focus choice alone while a delayed return refresh completes', async ({ page }) => {
  const f = await boot(page);
  try {
    await expand(page); await button(page, 'task:task-one').click(); await expect(page.locator('.work-entity-task-reader')).toBeVisible();
    f.hold('work_entity.get', 'promise-one'); await page.getByRole('button', { name: 'Back to commitment', exact: true }).click();
    await expect.poll(f.pending).toBe(true); const chosen = reader(page).locator('[data-commitment-section="evidence"] summary'); await chosen.click();
    f.release(); await expect(button(page, 'task:task-one')).toBeEnabled(); await expect(chosen).toBeFocused(); await expect(chosen.locator('..')).toHaveAttribute('open', '');
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

test('does not replace the original promise with a reused ID when returning from a linked record', async ({ page }) => {
  const f = await boot(page);
  try {
    await expand(page); await button(page, 'project:project-one').click(); await expect(page.locator('[data-project-overview]')).toBeVisible();
    f.replacePromise(); await page.getByRole('button', { name: 'Back to commitment', exact: true }).click();
    await expect(reader(page)).toHaveCount(0); await expect(page.getByRole('alert')).toContainText('no longer available with the same identity');
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
