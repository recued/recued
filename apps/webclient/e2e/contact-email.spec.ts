import { expect, test, type Page } from '@playwright/test';
import type { MailDraft, TimelineEntry, TimelineRequest } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { openChatHistory } from './helpers/chat-history.js';

installFullAppHooks();
type MailMode = 'ready' | 'none' | 'read_only' | 'draft_only' | 'unavailable';
const selectedAddress = 'alex+desk@example.test';
const detail = (page: Page) => page.locator('[data-recued-data-contact-detail]');
const email = (page: Page) => detail(page).getByRole('button', { name: 'Draft email', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'New mail', exact: true });
const field = (page: Page, name: string) => dialog(page).locator(`[data-form-field="${name}"]`);
const openContact = async (page: Page, address = selectedAddress) => {
  await page.evaluate(address => window.__app.setHash(`#data/contact/${encodeURIComponent(address)}`), address);
  await expect(email(page)).toBeVisible();
};
const discard = async (page: Page) => {
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
};

const boot = async (page: Page, mode: MailMode = 'ready', queued = false, activity = false): Promise<void> => {
  await page.addInitScript(({ mode, selectedAddress, activity }) => {
    let currentMode = mode, holdNext = false, reads = 0, completed = 0;
    let releaseRead: (() => void) | undefined;
    let saved: MailDraft | null = null;
    const executions: Array<{ recipe_id: string; config: Record<string, unknown> }> = [];
    const chatSends: Record<string, unknown>[] = [];
    const activityReads: TimelineRequest[] = [];
    let failActivity = false, holdActivity = false, ignoreActivityFilters = false, emptyActivity = false;
    let releaseActivity: (() => void) | undefined;
    const activityCursor = (row: TimelineEntry) => btoa(JSON.stringify({ v: 'v1', last_ts: row.ts,
      last_key: `${row.source}:${row.kind}:${(row.payload as { id: string }).id}` })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    Object.assign(window, { __contactActivity: { reads: activityReads,
      failNext() { failActivity = true; }, holdNext() { holdActivity = true; },
      pending() { return releaseActivity !== undefined; },
      release() { if (!releaseActivity) throw new Error('No activity read is waiting.'); const done = releaseActivity; releaseActivity = undefined; done(); },
      ignoreFilters(value: boolean) { ignoreActivityFilters = value; }, emptyNext() { emptyActivity = true; },
    } });
    const alex = { contact_id: 'contact-alex', email: 'alex@example.test', name: 'Alex Rivera', source: 'manual', interaction_count: 4,
      first_seen_at: 1_700_000_000_000, last_seen_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 };
    const contact = (address: string) => address === selectedAddress || address === alex.email || address === alex.contact_id ? alex
      : address === 'blair@example.test' ? { ...alex, contact_id: 'contact-blair', email: address, name: 'Blair Chen' }
        : address === 'merged@example.test' ? { ...alex, email: address, merged_into: alex.email } : null;
    Object.assign(window, { __contactMail: {
      executions, chatSends, saved: () => structuredClone(saved), reads: () => reads, completed: () => completed,
      setMode(value: MailMode) { currentMode = value; },
      hold() { holdNext = true; },
      release() { if (!releaseRead) throw new Error('No account read is waiting.'); const done = releaseRead; releaseRead = undefined; done(); },
    }, __connectionsFixture: async (method: string, raw: unknown) => {
      const args = raw as Record<string, unknown> | undefined;
      if (method === 'chat.send') chatSends.push(structuredClone(args!));
      if (method === 'contact.list') return { result: { contacts: [alex], total: 1, rollups: {} } };
      if (method === 'contact.get') return { result: { contact: contact(args?.email as string), identifiers: {
        emails: ['alex@example.test'], phones: [],
      } } };
      // An address with no contact of its own asks whose second address it is.
      if (method === 'contact.resolve') return { result: { contact: contact(args?.email as string) } };
      if (method === 'contact.search.local') return { result: { contacts: [
        { email: selectedAddress, name: alex.name }, { email: 'blair@example.test', name: 'Blair Chen' },
      ], total: 2, rollups: {} } };
      if (method === 'contact.contributions') return { result: { contributions: [] } };
      if (method === 'yours.read' && args?.contact_id) return { result: { episodes: [], occasions: [] } };
      if (method === 'data.timeline') {
        if (!activity) return { result: { entries: [] } };
        const request = structuredClone(args) as unknown as TimelineRequest; activityReads.push(request);
        const label = request.entity_id.includes('blair') ? 'Blair' : 'Alex';
        const rows: TimelineEntry[] = Array.from({ length: 260 }, (_, index) => ({ ts: 1_700_000_000_000 - index * 3_600_000,
          source: index === 0 ? 'enrichment' : 'annotation', kind: `${label} activity ${String(index).padStart(3, '0')}`,
          origin_actor: (['system', 'user_self', 'contracted_user', 'anonymous'] as const)[index % 4],
          payload: index === 0 ? { id: 'event-0', topic: 'role', value: 'Sponsor of the launch', authored_by: 'fixture', staleness_class: 'fresh', scope: 'contact', target_id: request.entity_id.slice(8) }
            : { id: `event-${index}`, body: `Private ${label} event ${index}` } }));
        let before: { last_ts: number; last_key: string } | undefined;
        if (request.cursor) before = JSON.parse(atob(request.cursor.replace(/-/g, '+').replace(/_/g, '/'))) as typeof before;
        const available = rows.filter(row => (!before || row.ts < before.last_ts)
          && (ignoreActivityFilters || (request.since === undefined || row.ts >= request.since)
            && (request.until === undefined || row.ts < request.until)
            && (!request.origin_actors || request.origin_actors.includes(row.origin_actor!))));
        const empty = emptyActivity && !!request.origin_actors; emptyActivity = false;
        const page = empty ? [] : available.slice(0, request.limit ?? 50);
        const result = { entries: page, ...(empty ? { next_cursor: activityCursor(rows[0]!) }
          : available.length > page.length ? { next_cursor: activityCursor(page.at(-1)!) } : {}),
          rollups: [{ publisher: 'fixture', pack_slug: 'contact-work', label: 'Current commitments', value: { open: 2 }, complete: true }] };
        if (holdActivity) { holdActivity = false; await new Promise<void>(done => { releaseActivity = done; }); }
        if (failActivity) { failActivity = false; return { error: { code: 'unavailable', message: 'Activity temporarily unavailable.' } }; }
        return { result };
      }
      if (method === 'collection.mail.list') {
        reads++;
        const responseMode = currentMode;
        if (holdNext) { holdNext = false; await new Promise<void>(done => { releaseRead = done; }); }
        completed++;
        if (responseMode === 'unavailable') return { error: { code: 'unavailable', message: 'Mail accounts unavailable.' } };
        return { result: { instances: responseMode === 'none' ? [] : [
          { slug: 'work', adapter_type: 'gmail', account_email: 'owner@example.test',
            send_capable: responseMode === 'ready', draft_capable: responseMode !== 'read_only',
            receive_capable: true, auth_state: 'healthy', caps: {} },
          ...(responseMode === 'ready' ? [{ slug: 'other', adapter_type: 'smtp', account_email: 'other@example.test',
            send_capable: true, draft_capable: false, receive_capable: false, auth_state: 'healthy', caps: {} }] : []),
        ] } };
      }
      if (method === 'mail.drafts.create' || method === 'mail.drafts.update') {
        saved = { draft_id: 'mad_00000000-0000-4000-8000-000000000001', incarnation: 'contact-draft',
          revision: (saved?.revision ?? 0) + 1, content: structuredClone(args?.content) as MailDraft['content'],
          origin_contract_id: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_001 };
        return { result: structuredClone(saved) };
      }
      if (method === 'execute') {
        executions.push(structuredClone(args) as { recipe_id: string; config: Record<string, unknown> });
        if (args?.recipe_id === 'draft-composed-mail') return { result: { success: true, output: { render: [{ type: 'text', data: 'Hello Alex,\nCould you review the revised quote?\nThank you.' }] } } };
        return { result: { success: false, awaiting_approval: true } };
      }
      return undefined;
    } });
  }, { mode, selectedAddress, activity });
  await page.goto(`${HARNESS_URL}?data=contacts&settle_reads=1&connection=source-answer${queued ? '&yours=demo&yours_asset_queue=1' : ''}#data/search`);
  await page.waitForFunction(() => window.__app?.ready === true);
};

test.describe('Contact activity browsing', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
  const feed = (page: Page) => detail(page).locator('[data-contact-activity-scope]');
  const rows = (page: Page) => feed(page).locator('.memory-timeline-entry');
  const status = (page: Page) => feed(page).getByRole('status');
  const begin = async (page: Page) => {
    await page.clock.setFixedTime(new Date(1_700_000_000_000));
    await boot(page, 'ready', false, true); await openContact(page, 'alex@example.test');
    await expect(status(page)).toHaveText('50 events shown. Older activity is available.');
  };

  test('loads older events once, retries the same failed cursor and focuses the new activity', async ({ page }) => {
    await begin(page); await page.evaluate(() => { window.__contactActivity.holdNext(); window.__contactActivity.failNext(); });
    await feed(page).getByRole('button', { name: 'Load older activity', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__contactActivity.pending())).toBe(true);
    await feed(page).getByRole('button', { name: 'Loading older activity…', exact: true }).press('Enter');
    expect(await page.evaluate(() => window.__contactActivity.reads.length)).toBe(2);
    await page.evaluate(() => window.__contactActivity.release());
    await expect(feed(page).getByRole('alert')).toContainText('Previously loaded activity remains');
    await expect(rows(page)).toHaveCount(50);
    await feed(page).getByRole('button', { name: 'Retry activity', exact: true }).click();
    await expect(rows(page)).toHaveCount(100);
    expect(await page.evaluate(() => window.__contactActivity.reads[1])).toEqual(await page.evaluate(() => window.__contactActivity.reads[2]));
    await expect(rows(page).nth(50)).toBeFocused();
  });

  test('filters on the server by local dates and actor while preserving enrichment and standing aggregates', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 }); await begin(page);
    await expect(detail(page).getByText('Sponsor of the launch', { exact: true })).toBeVisible();
    await feed(page).getByRole('combobox', { name: 'Date range', exact: true }).selectOption('custom');
    await feed(page).getByLabel('From', { exact: true }).fill('2023-11-13');
    await feed(page).getByLabel('Through', { exact: true }).fill('2023-11-13');
    await feed(page).getByRole('combobox', { name: 'Who acted', exact: true }).selectOption('anonymous');
    await expect(rows(page)).toHaveCount(50);
    await feed(page).getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(status(page)).toHaveText('6 events shown.');
    expect(await page.evaluate(() => window.__contactActivity.reads.at(-1))).toEqual({ entity_id: 'contact:alex@example.test', limit: 50,
      since: Date.parse('2023-11-13T08:00:00Z'), until: Date.parse('2023-11-14T08:00:00Z'), origin_actors: ['anonymous'] });
    await expect(status(page)).toBeFocused();
    await expect(detail(page).getByText('Sponsor of the launch', { exact: true })).toBeVisible();
    await expect(detail(page)).toContainText('Current commitments');
    await feed(page).screenshot({ path: testInfo.outputPath('contact-activity-filters-phone.png'), animations: 'disabled' });
    await feed(page).getByRole('button', { name: 'Reset filters', exact: true }).click();
    await expect(status(page)).toHaveText('50 events shown. Older activity is available.');
  });

  test('keeps invalid dates out of requests and continues through an empty filtered page', async ({ page }) => {
    await begin(page); const before = await page.evaluate(() => window.__contactActivity.reads.length);
    await feed(page).getByRole('combobox', { name: 'Date range', exact: true }).selectOption('custom');
    await feed(page).getByLabel('From', { exact: true }).fill('2023-11-15');
    await feed(page).getByLabel('Through', { exact: true }).fill('2023-11-14');
    await feed(page).getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(feed(page).getByRole('alert')).toContainText('From must be on or before Through');
    expect(await page.evaluate(() => window.__contactActivity.reads.length)).toBe(before); await expect(rows(page)).toHaveCount(50);
    await feed(page).getByRole('combobox', { name: 'Date range', exact: true }).selectOption('all');
    await feed(page).getByRole('combobox', { name: 'Who acted', exact: true }).selectOption('anonymous');
    await page.evaluate(() => window.__contactActivity.emptyNext());
    await feed(page).getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(status(page)).toHaveText('0 events shown. Older activity is available.');
    await expect(feed(page)).not.toContainText('No activity matches these filters.');
    await feed(page).getByRole('button', { name: 'Load older activity', exact: true }).click();
    await expect(rows(page)).toHaveCount(50); await expect(status(page)).toContainText('50 events shown');
  });

  test('drops a late older-page response when another contact opens', async ({ page }) => {
    await begin(page); await page.evaluate(() => window.__contactActivity.holdNext());
    await feed(page).getByRole('button', { name: 'Load older activity', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__contactActivity.pending())).toBe(true);
    await openContact(page, 'blair@example.test'); await expect(rows(page).first()).toContainText('Blair activity');
    await page.evaluate(() => window.__contactActivity.release());
    await expect(rows(page)).toHaveCount(50); await expect(feed(page)).not.toContainText('Alex activity');
  });

  test('restores filters, loaded history, keyboard focus and reading position after leaving Data', async ({ page }) => {
    await begin(page); await feed(page).getByRole('combobox', { name: 'Who acted', exact: true }).selectOption('anonymous');
    await feed(page).getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(rows(page)).toHaveCount(50);
    await feed(page).getByRole('button', { name: 'Load older activity', exact: true }).click();
    await expect(rows(page)).toHaveCount(65); await expect(rows(page).nth(50)).toBeFocused();
    await rows(page).nth(52).scrollIntoViewIfNeeded(); await rows(page).nth(52).focus();
    const top = (await rows(page).nth(52).boundingBox())!.y;
    await page.evaluate(() => window.__app.setHash('#chat')); await expect(feed(page)).toHaveCount(0);
    await openContact(page, 'alex@example.test');
    await expect(rows(page)).toHaveCount(65);
    await expect(feed(page).getByRole('combobox', { name: 'Who acted', exact: true })).toHaveValue('anonymous');
    await expect(rows(page).nth(52)).toBeFocused();
    await expect.poll(async () => Math.abs((await rows(page).nth(52).boundingBox())!.y - top)).toBeLessThan(8);
  });

  test('keeps the selected history through Memory and Data collection round trips', async ({ page }) => {
    await begin(page); await feed(page).getByRole('combobox', { name: 'Who acted', exact: true }).selectOption('user_self');
    await feed(page).getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(rows(page)).toHaveCount(50); await feed(page).getByRole('button', { name: 'Load older activity', exact: true }).click();
    await expect(rows(page)).toHaveCount(65);
    const lens = page.getByRole('group', { name: 'Data or Memory', exact: true });
    await lens.getByRole('button', { name: 'Memory', exact: true }).click(); await expect(feed(page)).toHaveCount(0);
    await lens.getByRole('button', { name: 'Data', exact: true }).click();
    await expect(rows(page)).toHaveCount(65);
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await page.getByRole('tab', { name: 'Contacts', exact: true }).click();
    await expect(rows(page)).toHaveCount(65);
    await expect(feed(page).getByRole('combobox', { name: 'Who acted', exact: true })).toHaveValue('user_self');
  });

  test('retries an initial activity failure and recovers its enrichment cards and aggregates', async ({ page }) => {
    await boot(page, 'ready', false, true); await page.evaluate(() => window.__contactActivity.failNext());
    await openContact(page, 'alex@example.test');
    await expect(feed(page).getByRole('alert')).toContainText('Activity temporarily unavailable');
    await expect(feed(page)).not.toContainText('No timeline events yet.');
    await expect(detail(page).getByText('Sponsor of the launch', { exact: true })).toHaveCount(0);
    await feed(page).getByRole('button', { name: 'Retry activity', exact: true }).click();
    await expect(rows(page)).toHaveCount(50);
    await expect(detail(page).getByText('Sponsor of the launch', { exact: true })).toBeVisible();
    await expect(detail(page)).toContainText('Current commitments');
    await expect(status(page)).toBeFocused();
  });

  test('reports unsupported filters rather than showing the unfiltered first page under them', async ({ page }) => {
    await begin(page); await page.evaluate(() => window.__contactActivity.ignoreFilters(true));
    await feed(page).getByRole('combobox', { name: 'Who acted', exact: true }).selectOption('anonymous');
    await feed(page).getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(feed(page).getByRole('alert')).toContainText('did not confirm');
    await expect(rows(page)).toHaveCount(0);
    await page.evaluate(() => window.__contactActivity.ignoreFilters(false));
    await feed(page).getByRole('button', { name: 'Retry activity', exact: true }).click(); await expect(rows(page)).toHaveCount(50);
  });
});

test('starts an editable email to the displayed address, preserves an open draft and returns to search after approval', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const search = page.getByRole('searchbox', { name: 'Search everything' });
  await search.fill('Northwind');
  const result = page.locator(`[data-search-contact-email="${selectedAddress}"]`);
  await result.click();
  await expect(detail(page)).toContainText(selectedAddress);
  await page.screenshot({ path: testInfo.outputPath('contact-email-mobile.png'), fullPage: true });
  const hash = await page.evaluate(() => location.hash);
  await email(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByLabel('What should this email say?', { exact: true })).toBeFocused();
  await expect(dialog(page).locator('[data-mail-compose-contact-context]')).toContainText('Alex Rivera');
  await expect(dialog(page).locator('[data-form-array-item="to"]')).toHaveValue(selectedAddress);
  await expect(field(page, 'subject')).toBeEmpty();
  await expect(field(page, 'body')).toBeEmpty();
  expect(await page.evaluate(() => window.__contactMail.executions)).toEqual([]);
  expect(await page.evaluate(() => window.__contactMail.saved())).toBeNull();
  await field(page, 'body').fill('Please review the revised scope.');
  // A second entry attempt cannot replace the draft, even before the modal's hit testing.
  await email(page).evaluate(button => (button as HTMLButtonElement).click());
  await expect(field(page, 'body')).toHaveValue('Please review the revised scope.');
  await expect(dialog(page)).toHaveCount(1);
  await expect(detail(page).getByRole('alert')).toContainText('Finish or close your open email');
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  await dialog(page).locator('[data-form-array-item="to"]').fill('reviewer@example.test');
  await dialog(page).locator('[data-action="select-mail-compose-sender"]').selectOption('other');
  await field(page, 'subject').fill('Scope review');
  await dialog(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(detail(page).getByRole('status').filter({ hasText: 'Email is waiting for approval.' })).toBeVisible();
  await expect(email(page)).toBeFocused();
  const sent = await page.evaluate(() => window.__contactMail.executions);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ recipe_id: 'send-composed-mail', config: { sender_mail_instance: 'other',
    to: ['reviewer@example.test'], subject: 'Scope review', body: 'Please review the revised scope.' } });
  expect(sent[0]?.config.in_reply_to ?? null).toBeNull();
  expect(sent[0]?.config.references ?? []).toEqual([]);
  expect(sent[0]?.config.cc ?? []).toEqual([]);
  expect(sent[0]?.config.bcc ?? []).toEqual([]);
  await page.getByRole('button', { name: /Back to search/ }).click();
  await expect(search).toHaveValue('Northwind');
  await expect(result).toBeFocused();
});

for (const [mode, message] of [
  ['none', 'Connect a mailbox in Connections'],
  ['read_only', 'Your mailboxes are read-only'],
  ['unavailable', 'Your mail accounts could not be checked'],
] as const) {
  test(`explains ${mode} mail readiness on the contact and retries without losing the profile`, async ({ page }) => {
    await boot(page, mode); await openContact(page);
    await email(page).focus();
    await email(page).press('Enter');
    await expect(detail(page).getByRole('alert')).toContainText(message);
    await expect(dialog(page)).toHaveCount(0);
    await expect(email(page)).toBeEnabled();
    await expect(email(page)).toBeFocused();
    await page.evaluate(() => window.__contactMail.setMode('ready'));
    await email(page).click();
    await expect(dialog(page)).toBeVisible();
    await discard(page);
    await expect(email(page)).toBeFocused();
    await expect(detail(page).getByRole('alert')).toHaveCount(0);
    await expect(detail(page)).not.toContainText('Email sent.');
    expect(await page.evaluate(() => window.__contactMail.executions)).toEqual([]);
  });
}

test('keeps a draft-only mailbox useful without enabling sending', async ({ page }) => {
  await boot(page, 'draft_only'); await openContact(page);
  await email(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(dialog(page).getByRole('button', { name: 'Schedule…', exact: true })).toBeDisabled();
  await field(page, 'subject').fill('Follow up');
  await field(page, 'body').fill('Save this for later.');
  await dialog(page).getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('[data-mail-draft-status]')).toContainText('Draft saved.');
  expect(await page.evaluate(() => window.__contactMail.saved()?.content)).toMatchObject({
    sender_mail_instance: 'work', to: [selectedAddress], subject: 'Follow up', body: 'Save this for later.',
  });
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(email(page)).toBeFocused();
  expect(await page.evaluate(() => window.__contactMail.executions)).toEqual([]);
});

test('retires an old contact account read while a newer contact opens its own email', async ({ page }) => {
  await boot(page); await openContact(page);
  await page.evaluate(() => window.__contactMail.hold());
  await email(page).click();
  await expect(detail(page).getByRole('button', { name: 'Opening…', exact: true })).toBeDisabled();
  await openContact(page, 'blair@example.test');
  await email(page).click();
  await expect(dialog(page).locator('[data-form-array-item="to"]')).toHaveValue('blair@example.test');
  await field(page, 'body').fill('Blair draft');
  const completed = await page.evaluate(() => window.__contactMail.completed());
  await page.evaluate(() => window.__contactMail.release());
  await expect.poll(() => page.evaluate(() => window.__contactMail.completed())).toBe(completed + 1);
  await expect(dialog(page)).toHaveCount(1);
  await expect(dialog(page).locator('[data-form-array-item="to"]')).toHaveValue('blair@example.test');
  await expect(field(page, 'body')).toHaveValue('Blair draft');
  await discard(page);
});

test('leaving Data retires a pending account read without a late compose portal', async ({ page }) => {
  await boot(page); await openContact(page);
  await page.evaluate(() => window.__contactMail.hold());
  await email(page).click();
  await expect(detail(page).getByRole('button', { name: 'Opening…', exact: true })).toBeDisabled();
  const completed = await page.evaluate(() => window.__contactMail.completed());
  await page.evaluate(() => window.__app.setHash('#chat'));
  await expect(detail(page)).toHaveCount(0);
  await page.evaluate(() => window.__contactMail.release());
  await expect.poll(() => page.evaluate(() => window.__contactMail.completed())).toBe(completed + 1);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('[data-mail-reply-compose-portal]')).toHaveCount(0);
});

test('a Memory round trip retires the old account read and allows a fresh Email attempt', async ({ page }) => {
  await boot(page); await openContact(page);
  await page.evaluate(() => window.__contactMail.hold());
  await email(page).click();
  await expect(detail(page).getByRole('button', { name: 'Opening…', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await expect(detail(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await expect(email(page)).toBeEnabled();
  await email(page).click();
  await expect(dialog(page)).toBeVisible();
  const completed = await page.evaluate(() => window.__contactMail.completed());
  await page.evaluate(() => window.__contactMail.release());
  await expect.poll(() => page.evaluate(() => window.__contactMail.completed())).toBe(completed + 1);
  await expect(dialog(page)).toHaveCount(1);
  await expect(dialog(page).locator('[data-form-array-item="to"]')).toHaveValue(selectedAddress);
  await discard(page);
});

test('browser Back honors the email draft guard before returning to search', async ({ page }) => {
  await boot(page);
  const search = page.getByRole('searchbox', { name: 'Search everything' });
  await search.fill('Northwind');
  const result = page.locator(`[data-search-contact-email="${selectedAddress}"]`);
  await result.click();
  const contactHash = await page.evaluate(() => location.hash);
  await email(page).click();
  await field(page, 'body').fill('Keep this unfinished email.');
  const prompts: string[] = [];
  page.once('dialog', prompt => { prompts.push(prompt.message()); void prompt.dismiss(); });
  await page.goBack();
  await expect.poll(() => prompts.length).toBe(1);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(contactHash);
  await expect(field(page, 'body')).toHaveValue('Keep this unfinished email.');
  await discard(page);
  await page.goBack();
  await expect(search).toHaveValue('Northwind');
  await expect(result).toBeFocused();
  await result.click();
  await email(page).click();
  page.once('dialog', prompt => { prompts.push(prompt.message()); void prompt.accept(); });
  await page.goBack();
  await expect.poll(() => prompts.length).toBe(2);
  await expect(dialog(page)).toHaveCount(0);
  await expect(search).toBeVisible();
});

test('contact editing retires a pending Email check and allows a fresh email after editing', async ({ page }) => {
  await boot(page); await openContact(page);
  await page.evaluate(() => window.__contactMail.hold());
  await email(page).click();
  await expect(detail(page).getByRole('button', { name: 'Opening…', exact: true })).toBeDisabled();
  await detail(page).getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit contact', exact: true });
  await editor.getByLabel('Name', { exact: true }).fill('Alex, edited locally');
  const completed = await page.evaluate(() => window.__contactMail.completed());
  await page.evaluate(() => window.__contactMail.release());
  await expect.poll(() => page.evaluate(() => window.__contactMail.completed())).toBe(completed + 1);
  await expect(dialog(page)).toHaveCount(0);
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Alex, edited locally');
  await expect(editor.getByLabel('Name', { exact: true })).toBeFocused();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await editor.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(email(page)).toBeEnabled();
  await email(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('[data-form-array-item="to"]')).toHaveValue(selectedAddress);
  await discard(page);
  expect(await page.evaluate(() => window.__contactMail.executions)).toEqual([]);
});

test('offers no Email action for a missing or merged contact', async ({ page }) => {
  await boot(page);
  for (const address of ['missing@example.test', 'merged@example.test']) {
    await page.evaluate(address => window.__app.setHash(`#data/contact/${encodeURIComponent(address)}`), address);
    await expect(detail(page)).toContainText(address === 'missing@example.test' ? 'No contact record found' : 'This contact was merged');
    await expect(email(page)).toHaveCount(0);
    await expect(detail(page).getByRole('button', { name: 'Chat about this', exact: true })).toHaveCount(0);
  }
  expect(await page.evaluate(() => window.__contactMail.reads())).toBe(0);
});

test('Draft email uses the existing AI proposal and clears the contact label when the recipient changes', async ({ page }) => {
  await boot(page); await openContact(page); await email(page).click();
  const brief = dialog(page).getByRole('textbox', { name: 'What should this email say?', exact: true });
  await expect(brief).toBeFocused(); await expect(field(page, 'body')).toBeEmpty();
  expect(await page.evaluate(() => window.__contactMail.executions)).toEqual([]);
  await brief.fill('A'.repeat(7995));
  await dialog(page).getByRole('button', { name: 'Draft with AI', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText('Shorten your instructions before drafting.');
  expect(await page.evaluate(() => window.__contactMail.executions)).toEqual([]);
  await brief.fill('Ask for the revised quote.');
  await dialog(page).getByRole('button', { name: 'Draft with AI', exact: true }).click();
  await expect(field(page, 'body')).toHaveValue('Hello Alex,\nCould you review the revised quote?\nThank you.');
  const first = await page.evaluate(() => window.__contactMail.executions[0]!);
  expect(first.recipe_id).toBe('draft-composed-mail');
  expect(first.config).toMatchObject({ to: [selectedAddress], brief: expect.stringContaining('Ask for the revised quote.') });
  expect(String(first.config.brief)).toContain('"name":"Alex Rivera"');
  await field(page, 'body').fill('My edited version of the proposal.');
  await dialog(page).locator('[data-form-array-item="to"]').fill('blair@example.test');
  await expect(dialog(page).locator('[data-mail-compose-contact-context]')).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Draft with AI', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__contactMail.executions.length)).toBe(2);
  const second = await page.evaluate(() => window.__contactMail.executions[1]!);
  expect(second.config.to).toEqual(['blair@example.test']);
  expect(second.config.brief).toBe('Ask for the revised quote.');
  expect(await page.evaluate(() => window.__contactMail.executions.some(call => call.recipe_id === 'send-composed-mail'))).toBe(false);
});

test('View activity moves keyboard focus to the contact timeline without changing the route', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await boot(page); await openContact(page);
  const hash = await page.evaluate(() => location.hash);
  const action = detail(page).getByRole('button', { name: 'View activity', exact: true });
  await action.focus(); await action.press('Enter');
  await expect(detail(page).getByRole('heading', { name: 'Activity', exact: true })).toBeFocused();
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  expect(await page.evaluate(() => window.__contactMail.executions)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('contact-activity-phone.png') });
});

test('Chat about this selects the exact contact, ignores a late mail check and protects the question on return', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await boot(page); await openContact(page);
  await page.evaluate(() => window.__contactMail.hold());
  const completed = await page.evaluate(() => window.__contactMail.completed());
  await email(page).click();
  await expect(detail(page).getByRole('button', { name: 'Opening…', exact: true })).toBeDisabled();
  await detail(page).getByRole('button', { name: 'Chat about this', exact: true }).click();
  const context = page.getByRole('group', { name: 'Selected contact', exact: true });
  const input = page.getByRole('textbox', { name: 'Message to Recued', exact: true });
  await expect(context.getByRole('link', { name: 'Alex Rivera', exact: true })).toHaveAttribute('href', '#data/contact/contact-alex');
  await expect(input).toHaveValue('What should I know about this contact?');
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.session.create'))).toBe(0);
  expect(await page.evaluate(() => window.__contactMail.chatSends)).toEqual([]);
  await page.evaluate(() => window.__contactMail.release());
  await expect.poll(() => page.evaluate(() => window.__contactMail.completed())).toBe(completed + 1);
  await expect(dialog(page)).toHaveCount(0);
  await input.fill('Help me prepare for our next conversation.');
  await page.screenshot({ path: testInfo.outputPath('contact-chat-phone.png') });
  const prompts: string[] = [];
  page.once('dialog', prompt => { prompts.push(prompt.message()); void prompt.dismiss(); });
  await context.getByRole('link', { name: 'Alex Rivera', exact: true }).click();
  await expect.poll(() => prompts.length).toBe(1);
  await expect(input).toHaveValue('Help me prepare for our next conversation.'); await expect(context).toBeVisible();
  page.once('dialog', prompt => { void prompt.accept(); });
  await context.getByRole('link', { name: 'Alex Rivera', exact: true }).click();
  await expect(detail(page).getByRole('heading', { name: 'Alex Rivera', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__contactMail.chatSends)).toEqual([]);
});

test('contact questions send references through ordinary Chat and remain readable in history', async ({ page }) => {
  await boot(page); await openContact(page);
  await detail(page).getByRole('button', { name: 'Chat about this', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message to Recued', exact: true }).fill('Which commitments need my attention?');
  await page.locator('[data-recued-chat-route-send]').click();
  await expect.poll(() => page.evaluate(() => window.__contactMail.chatSends.length)).toBe(1);
  const sent = await page.evaluate(() => window.__contactMail.chatSends[0]!);
  expect(String(sent.message)).toContain('Which commitments need my attention?');
  expect(String(sent.message)).toContain('"contact":{"id":"contact-alex","email":"alex@example.test"}');
  expect(String(sent.message)).not.toContain('Alex Rivera');
  await expect(page.getByRole('group', { name: 'Selected contact', exact: true })).toHaveCount(0);
  await page.locator('[data-recued-chat-route-new-session]').click(); await openChatHistory(page);
  await page.locator('[data-recued-chat-route-session-row]').first().click();
  const question = page.locator('[data-chat-contact-question]');
  await expect(question).toContainText('Which commitments need my attention?');
  await expect(question.getByRole('link', { name: 'Open selected contact', exact: true })).toHaveAttribute('href', '#data/contact/contact-alex');
  await expect(question.locator('pre')).toBeHidden();
});

test('removing contact context preserves the question and sends an ordinary message', async ({ page }) => {
  await boot(page); await openContact(page);
  await detail(page).getByRole('button', { name: 'Chat about this', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message to Recued', exact: true }); await input.fill('A different question.');
  await page.getByRole('button', { name: 'Remove contact context', exact: true }).click();
  await expect(input).toHaveValue('A different question.');
  await expect(page.getByRole('group', { name: 'Selected contact', exact: true })).toHaveCount(0);
  await page.locator('[data-recued-chat-route-send]').click();
  await expect.poll(() => page.evaluate(() => window.__contactMail.chatSends[0]?.message)).toBe('A different question.');
});

test('withdrawing a queued contact question restores the selected contact and protects context-only work', async ({ page }) => {
  await boot(page, 'ready', true); await openContact(page);
  await detail(page).getByRole('button', { name: 'Chat about this', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message to Recued', exact: true });
  await input.fill('Prepare a follow-up question.'); await page.locator('[data-recued-chat-route-send]').click();
  const queue = page.getByRole('region', { name: 'Conversation queue', exact: true });
  await expect(queue).toContainText('Queued: Prepare a follow-up question.');
  await expect(queue).not.toContainText('recued.contact_question');
  await queue.getByRole('button', { name: 'Withdraw to edit', exact: true }).click();
  const context = page.getByRole('group', { name: 'Selected contact', exact: true });
  await expect(input).toHaveValue('Prepare a follow-up question.');
  await expect(context.getByRole('link')).toHaveAttribute('href', '#data/contact/contact-alex');
  await input.fill(''); await queue.getByRole('button', { name: 'Restore withdrawn draft', exact: true }).click();
  await expect(queue).toContainText('Send or clear your current draft'); await expect(input).toHaveValue('');
  await expect(context).toBeVisible();
  await input.fill('Ask about the revised quote.'); await page.locator('[data-recued-chat-route-send]').click();
  await expect.poll(() => page.evaluate(() => window.__contactMail.chatSends.length)).toBe(2);
  const sent = await page.evaluate(() => window.__contactMail.chatSends);
  expect(String(sent[1]!.message)).toContain('Ask about the revised quote.');
  expect(String(sent[1]!.message)).toContain('"id":"contact-alex"');
  expect(sent[1]!.submission_id).not.toBe(sent[0]!.submission_id);
});

declare global { interface Window { __contactMail: {
  executions: Array<{ recipe_id: string; config: Record<string, unknown> }>;
  chatSends: Record<string, unknown>[];
  saved(): MailDraft | null; reads(): number; completed(): number;
  setMode(value: MailMode): void; hold(): void; release(): void;
} } }

declare global { interface Window { __contactActivity: {
  reads: TimelineRequest[]; failNext(): void; holdNext(): void; pending(): boolean; release(): void;
  ignoreFilters(value: boolean): void; emptyNext(): void;
} } }
