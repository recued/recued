import { expect, test, type Page } from '@playwright/test';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { openChatHistory } from './helpers/chat-history.js';
import { installCalendarEventFixture, type CalendarEventFixtureMode } from './helpers/calendar-event-fixture.js';
import { installCalendarRecoveryFixture } from './helpers/calendar-recovery-fixture.js';
import { serializeSourceRecordAddress } from '../src/shell/route.js';

installFullAppHooks();
test.use({ timezoneId: 'Asia/Tokyo' });
const meeting = 'https://meet.example.test/planning?code=a&guest=b';
const detail = (page: Page) => page.locator('.calendar-event');
const copy = (page: Page) => detail(page).getByRole('button', { name: 'Copy event details', exact: true });
const input = (page: Page) => page.getByRole('textbox', { name: 'Message to Recued', exact: true });

const open = async (page: Page, mode: CalendarEventFixtureMode = 'connected', url: string | undefined = meeting, cancelled = false) => {
  await page.clock.setFixedTime(new Date('2026-10-28T12:00:00Z'));
  await installCalendarEventFixture(page, mode);
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&connection=source-answer`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(({ url, cancelled }) => {
    window.__calendarEvent.setConferenceUrl(url);
    if (cancelled) window.__calendarEvent.setStatus('cancelled');
    window.__app.setHash('#data/calendar');
  }, { url, cancelled });
  await page.locator('[data-collection-record]').first().click();
  await expect(detail(page).getByRole('heading', { name: mode === 'all-day' ? 'Team retreat' : 'Customer planning', exact: true })).toBeVisible();
};

const clipboard = async (page: Page, mode: 'ready' | 'denied' | 'hold' | 'legacy' = 'ready') => {
  await page.evaluate(mode => {
    const values: string[] = [];
    let release: ((value: boolean) => void) | undefined;
    Object.assign(window, { __eventClipboard: { values,
      release(ok: boolean) { if (!release) throw new Error('No clipboard request is waiting.'); const done = release; release = undefined; done(ok); },
    } });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'legacy' ? undefined : {
      writeText: async (text: string) => {
        values.push(text);
        if (mode === 'denied' || mode === 'hold' && !(await new Promise<boolean>(done => { release = done; }))) throw new Error('Clipboard denied');
      },
    } });
    if (mode === 'legacy') Object.defineProperty(document, 'execCommand', { configurable: true, value: (command: string) => {
      if (command !== 'copy' || !(document.activeElement instanceof HTMLTextAreaElement)) throw new Error('Expected selected copy text');
      values.push(document.activeElement.value); return true;
    } });
  }, mode);
};

test('calendar quick actions join the saved meeting and copy its event zone without editing a read-only calendar', async ({ page }, testInfo) => {
  await open(page); await clipboard(page);
  await expect(detail(page).getByRole('button', { name: 'Edit event', exact: true })).toHaveCount(0);
  const join = detail(page).getByRole('link', { name: 'Join meeting', exact: true });
  await expect(join).toHaveAttribute('href', meeting);
  await expect(join).toHaveAttribute('target', '_blank');
  await expect(join).toHaveAttribute('rel', 'noopener noreferrer');
  // Keep the synthetic conference URL local while exercising the native link.
  await page.context().route('https://meet.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Meeting fixture</title>' }));
  const popup = page.waitForEvent('popup'); await join.click(); const opened = await popup;
  await expect(opened).toHaveURL(meeting); await opened.close();
  await copy(page).click();
  await expect(detail(page)).toContainText('Event details copied.');
  const copied = await page.evaluate(() => window.__eventClipboard.values);
  expect(copied).toEqual(['Customer planning\nStart: Wednesday, October 28, 2026 at 9:00:12 AM PDT\nEnd: Wednesday, October 28, 2026 at 10:00:12 AM PDT\nTime zone: America/Los_Angeles\nLocation: Meeting room 2\nMeeting link: ' + meeting]);
  await expect(copy(page)).toBeFocused();
  expect(await page.evaluate(() => window.__calendarEvent.writes)).toEqual([]);
  expect(await page.evaluate(() => window.__calendarEvent.responses)).toEqual([]);
  await detail(page).screenshot({ path: testInfo.outputPath('event-actions-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  await detail(page).screenshot({ path: testInfo.outputPath('event-actions-phone-dark.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('calendar quick actions omit missing, unsafe and cancelled Join links and copy inclusive all-day dates with the legacy clipboard', async ({ page }) => {
  await open(page, 'all-day', 'javascript:alert(1)'); await clipboard(page, 'legacy');
  await expect(detail(page).getByRole('link', { name: 'Join meeting', exact: true })).toHaveCount(0);
  await copy(page).click();
  await expect(detail(page)).toContainText('Event details copied.');
  expect(await page.evaluate(() => window.__eventClipboard.values[0])).toBe('Team retreat\nAll day: Saturday, October 31, 2026 – Monday, November 2, 2026\nLocation: Meeting room 2');
  await page.evaluate(url => { window.__calendarEvent.setConferenceUrl(url); window.__calendarEvent.setStatus('cancelled'); window.__app.setHash('#data/calendar'); }, meeting);
  await expect(page.getByRole('region', { name: 'Calendar agenda', exact: true })).toBeVisible();
  // Cancelled events leave the agenda but remain readable by their exact address.
  await page.evaluate(() => window.__app.setHash('#data/calendar/record/local/cal%3Alocal%3Aevent-1'));
  await expect(detail(page)).toContainText('Cancelled');
  await expect(detail(page).getByRole('link', { name: 'Join meeting', exact: true })).toHaveCount(0);
  await detail(page).getByRole('button', { name: 'Chat about this', exact: true }).click();
  await expect(input(page)).toHaveValue('What should I know about this cancelled event?');
  page.once('dialog', prompt => { void prompt.accept(); });
  await page.evaluate(() => { window.__calendarEvent.setStatus('confirmed'); window.__calendarEvent.setConferenceUrl();
    window.__app.setHash('#data/calendar/record/local/cal%3Alocal%3Aevent-1'); });
  await expect(copy(page)).toBeVisible();
  await expect(detail(page).getByRole('link', { name: 'Join meeting', exact: true })).toHaveCount(0);
});

test('calendar copying reports denial and ignores a late result after editing or leaving the event', async ({ page }) => {
  await open(page, 'timed'); await clipboard(page, 'denied');
  await copy(page).click(); await expect(detail(page).getByRole('alert')).toContainText('Could not copy.');
  await clipboard(page, 'hold'); await copy(page).click();
  await expect(detail(page).getByRole('button', { name: 'Copying…', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await detail(page).getByRole('button', { name: 'Edit event', exact: true }).click();
  const title = page.locator('[data-calendar-event-field="summary"]'); await title.fill('My unfinished title');
  await page.evaluate(() => window.__eventClipboard.release(false));
  await expect(title).toHaveValue('My unfinished title'); await expect(title).toBeFocused();
  await expect(detail(page).getByRole('alert')).toHaveCount(0);
  await detail(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await detail(page).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await clipboard(page, 'hold'); await copy(page).click();
  await detail(page).getByRole('button', { name: 'Chat about this', exact: true }).click();
  await expect(input(page)).toHaveValue('Help me prepare for this meeting.');
  await page.evaluate(() => window.__eventClipboard.release(false));
  await expect(input(page)).toHaveValue('Help me prepare for this meeting.');
  await expect(page.getByText('Could not copy. Select the event details and copy them.', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__calendarEvent.writes)).toEqual([]);
});

test('calendar Chat drafts select the exact event, protect edits on return and send references readable in history', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await open(page);
  await detail(page).getByRole('button', { name: 'Chat about this', exact: true }).click();
  const context = page.getByRole('group', { name: 'Selected event', exact: true });
  const back = context.getByRole('link', { name: 'Customer planning', exact: true });
  await expect(back).toHaveAttribute('href', '#data/calendar/record/work/cal%3Awork%3Aevent-1');
  await expect(context).toContainText('Planning');
  await expect(input(page)).toHaveValue('Help me prepare for this meeting.');
  expect(await page.evaluate(() => window.__app.rpcCallCount('chat.session.create'))).toBe(0);
  expect(await page.evaluate(() => window.__calendarEvent.chatSends)).toEqual([]);
  await input(page).fill('Which questions should I ask?');
  const prompts: string[] = [];
  page.once('dialog', prompt => { prompts.push(prompt.message()); void prompt.dismiss(); });
  await back.click(); await expect.poll(() => prompts.length).toBe(1);
  await expect(input(page)).toHaveValue('Which questions should I ask?'); await expect(context).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('event-chat-phone.png') });
  await page.locator('[data-recued-chat-route-send]').click();
  await expect.poll(() => page.evaluate(() => window.__calendarEvent.chatSends.length)).toBe(1);
  const sent = await page.evaluate(() => window.__calendarEvent.chatSends[0]!);
  const message = String(sent.message);
  expect(message).toContain('Which questions should I ask?');
  expect(JSON.parse(message.slice(message.lastIndexOf('\n') + 1))).toEqual({ kind: 'recued.calendar_question', version: 1,
    event: { calendar: 'work', source_id: 'event-1', record_id: 'cal:work:event-1', incarnation: 'local-calendar-1' } });
  // D-406 (Q4) — and the event rides as a pick, read before the first round.
  expect(sent.calendar_refs).toEqual([{ slug: 'work', record_id: 'cal:work:event-1' }]);
  expect(message).not.toContain('Customer planning'); expect(message).not.toContain(meeting);
  await expect(context).toHaveCount(0);
  await openChatHistory(page); await page.locator('[data-recued-chat-route-new-session]').click(); await openChatHistory(page);
  await page.locator('[data-recued-chat-route-session-row]').first().click();
  const question = page.locator('[data-chat-calendar-question]');
  await expect(question).toContainText('Which questions should I ask?');
  await expect(question.locator('pre')).toBeHidden();
  await question.getByRole('link', { name: 'Open selected event', exact: true }).click();
  await expect(detail(page).getByRole('heading', { name: 'Customer planning', exact: true })).toBeVisible();
});

test('removing calendar context preserves the editable question and sends ordinary Chat', async ({ page }) => {
  await open(page); await detail(page).getByRole('button', { name: 'Chat about this', exact: true }).click();
  await input(page).fill('A different question.');
  await page.getByRole('button', { name: 'Remove event context', exact: true }).click();
  await expect(input(page)).toHaveValue('A different question.');
  await expect(page.getByRole('group', { name: 'Selected event', exact: true })).toHaveCount(0);
  await page.locator('[data-recued-chat-route-send]').click();
  await expect.poll(() => page.evaluate(() => window.__calendarEvent.chatSends[0]?.message)).toBe('A different question.');
  expect(await page.evaluate(() => window.__calendarEvent.chatSends[0])).not.toHaveProperty('calendar_refs');
});

declare global { interface Window { __eventClipboard: { values: string[]; release(ok: boolean): void } } }

test.describe('duplicate calendar event', () => {
  const form = (page: Page) => page.getByRole('region', { name: 'Duplicate event', exact: true });
  const recovery = (page: Page) => page.getByRole('region', { name: 'Unfinished calendar events', exact: true });
  const duplicate = (page: Page) => detail(page).getByRole('button', { name: 'Duplicate event', exact: true });
  const bootSource = async (page: Page, recordId: string) => {
    const href = serializeSourceRecordAddress({ tab: 'calendar', collectionSlug: 'work', recordId });
    await page.goto(`${HARNESS_URL}?journey=verification&server_profiles=multiple${href}`);
    await page.waitForFunction(() => window.__app?.ready === true);
    await expect(duplicate(page)).toBeVisible();
    return href;
  };
  const reload = async (page: Page) => {
    const accept = (dialog: import('@playwright/test').Dialog) => { void dialog.accept(); };
    page.on('dialog', accept);
    try { await page.reload(); } finally { page.off('dialog', accept); }
    await page.waitForFunction(() => window.__app?.ready === true);
  };

  test('creates a reviewed copy in the source zone and returns to the unchanged original', async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date('2026-10-31T12:00:00Z'));
    const fixture = await installCalendarRecoveryFixture(page);
    try {
      const title = 'Planning <review> & follow-up', notes = '\nOriginal notes\nKeep this second line.';
      const original = await fixture.seed({ summary: title, description: notes, location: 'Room 5',
        end_at: Date.parse('2026-10-28T17:15:15.123Z') });
      const href = await bootSource(page, original.snapshot.record.record_id);
      const before = fixture.get(original.snapshot.event.source_id);
      await duplicate(page).click();
      await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue(title);
      await expect(form(page).getByLabel('Notes (optional)', { exact: true })).toHaveValue(notes);
      await expect(form(page).getByLabel('Location (optional)', { exact: true })).toHaveValue('Room 5');
      await expect(form(page)).toContainText('Times in America/New_York');
      await expect(form(page).getByLabel('Calendar', { exact: true })).toHaveValue(JSON.stringify(['work', 'primary']));
      await expect(form(page).getByLabel('Starts', { exact: true })).toHaveValue('');
      await expect(form(page).getByLabel('Ends', { exact: true })).toHaveValue('');
      await expect(form(page).getByLabel('Add guests', { exact: true })).toHaveValue('');
      expect(fixture.requests).toEqual([]);
      await form(page).getByLabel('Starts', { exact: true }).fill('2026-11-02T09:00');
      await expect(form(page).getByLabel('Ends', { exact: true })).toHaveValue('2026-11-02T10:15:15.123');
      await form(page).screenshot({ path: testInfo.outputPath('duplicate-desktop.png') });
      await form(page).getByRole('button', { name: 'Create event', exact: true }).click();
      await expect(form(page)).toHaveCount(0);
      await expect(detail(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toEqual(expect.objectContaining({ summary: title, description: notes, location: 'Room 5', timezone: 'America/New_York',
        start_at: Date.parse('2026-11-02T14:00:00Z'), end_at: Date.parse('2026-11-02T15:15:15.123Z'), is_all_day: false }));
      expect(fixture.requests[0]).not.toHaveProperty('guests');
      expect(fixture.requests[0]).not.toHaveProperty('send_invitations');
      expect(fixture.providerCalls()).toBe(2);
      expect(fixture.get(original.snapshot.event.source_id)).toEqual(before);
      const back = page.getByRole('link', { name: 'Back to original event', exact: true });
      await expect(back).toHaveAttribute('href', href); await back.click();
      await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
      await expect(detail(page)).toContainText('Wednesday, October 28, 2026');
      await expect(page.getByRole('link', { name: 'Back to original event', exact: true })).toHaveCount(0);
    } finally { await fixture.dispose(); }
  });

  test('recovers an all-day copy at its original event and cancels without creating anything', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.setFixedTime(new Date('2026-10-31T12:00:00Z'));
    const fixture = await installCalendarRecoveryFixture(page);
    try {
      const original = await fixture.seed({ summary: 'Three-day retreat', is_all_day: true,
        start_at: Date.parse('2026-10-31T00:00:00Z'), end_at: Date.parse('2026-11-03T00:00:00Z') });
      const href = await bootSource(page, original.snapshot.record.record_id), before = fixture.get(original.snapshot.event.source_id);
      await duplicate(page).click();
      await expect(form(page).getByLabel('All day', { exact: true })).toBeChecked();
      await form(page).getByLabel('First day', { exact: true }).fill('2026-11-02');
      await expect(form(page).getByLabel('Last day (inclusive)', { exact: true })).toHaveValue('2026-11-04');
      await form(page).screenshot({ path: testInfo.outputPath('duplicate-phone.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await reload(page);
      await expect(form(page)).toHaveCount(0); await expect(recovery(page)).toContainText('Three-day retreat');
      await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
      await expect(form(page)).toContainText('Times in America/New_York');
      await expect(form(page)).toContainText('Original span: 3 days');
      await form(page).getByLabel('First day', { exact: true }).fill('2026-11-05');
      await expect(form(page).getByLabel('Last day (inclusive)', { exact: true })).toHaveValue('2026-11-07');
      await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      await form(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
      await expect(form(page)).toHaveCount(0); await expect(duplicate(page)).toBeFocused();
      expect(new URL(page.url()).hash).toBe(href);
      expect(fixture.requests).toEqual([]); expect(fixture.providerCalls()).toBe(1);
      expect(fixture.get(original.snapshot.event.source_id)).toEqual(before);
      await reload(page); await expect(recovery(page)).toHaveCount(0);
    } finally { await fixture.dispose(); }
  });

  test('checks an uncertain creation after reload with one provider copy and the same request', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-31T12:00:00Z'));
    const fixture = await installCalendarRecoveryFixture(page);
    try {
      const original = await fixture.seed(), before = fixture.get(original.snapshot.event.source_id);
      const href = await bootSource(page, original.snapshot.record.record_id);
      await duplicate(page).click();
      await form(page).getByLabel('Starts', { exact: true }).fill('2026-11-02T09:00');
      fixture.loseNextReply();
      await form(page).getByRole('button', { name: 'Create event', exact: true }).click();
      await expect(form(page).getByRole('button', { name: 'Check save', exact: true })).toBeVisible();
      await expect(form(page).getByLabel('Title', { exact: true })).toBeDisabled();
      expect(fixture.providerCalls()).toBe(2);
      await reload(page);
      await recovery(page).getByRole('button', { name: 'Resume draft', exact: true }).click();
      await expect(form(page).getByLabel('Title', { exact: true })).toBeDisabled();
      await form(page).getByRole('button', { name: 'Check save', exact: true }).click();
      await expect(form(page)).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Back to original event', exact: true })).toHaveAttribute('href', href);
      expect(fixture.requests).toHaveLength(2); expect(fixture.requests[1]).toEqual(fixture.requests[0]);
      expect(fixture.providerCalls()).toBe(2);
      expect(fixture.get(original.snapshot.event.source_id)).toEqual(before);
    } finally { await fixture.dispose(); }
  });

  test('copies one recurring occurrence from a read-only calendar and invites only reviewed guests', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      window.__calendarEvent.setRecurring(true);
      window.__calendarEvent.setAttendees([{ email: 'old@example.com', response_status: 'accepted' }]);
    });
    const before = await page.evaluate(() => window.__calendarEvent.saved());
    await duplicate(page).click();
    await expect(detail(page)).toContainText('Recurring');
    await expect(form(page)).toContainText('One-off event');
    await expect(form(page)).not.toContainText('old@example.com');
    await form(page).getByLabel('Starts', { exact: true }).fill('2026-11-02T09:00');
    await form(page).getByLabel('Add guests', { exact: true }).fill('ada@example.com');
    await form(page).getByRole('button', { name: 'Add guest', exact: true }).click();
    await form(page).getByRole('button', { name: 'Create and send invitations', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    const state = await page.evaluate(() => ({ requests: window.__calendarEvent.creates, original: window.__calendarEvent.saved(), writes: window.__calendarEvent.writes }));
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]).toEqual(expect.objectContaining({ guests: [{ email: 'ada@example.com' }], send_invitations: true,
      start_at: Date.parse('2026-11-02T17:00:00Z'), end_at: Date.parse('2026-11-02T18:00:00Z') }));
    for (const key of ['is_recurring', 'attendees', 'conference_url', 'source_id', 'ical_uid']) expect(state.requests[0]).not.toHaveProperty(key);
    expect(state.original).toEqual(before); expect(state.writes).toEqual([]);
    await expect(detail(page)).not.toContainText('Recurring');
    await expect(detail(page)).toContainText('ada@example.com');
    await expect(detail(page).getByRole('link', { name: 'Join meeting', exact: true })).toHaveCount(0);
  });

  test('retires a delayed source read when a newer ordinary event draft owns the page', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__calendarEvent.holdNextRead());
    await duplicate(page).click();
    await expect.poll(() => page.evaluate(() => window.__calendarEvent.readPending())).toBe(true);
    await page.locator('[data-recued-data-action="collection-detail-close"]').click();
    await page.getByRole('button', { name: 'New event', exact: true }).click();
    const ordinary = page.getByRole('region', { name: 'New event', exact: true });
    await ordinary.getByLabel('Title', { exact: true }).fill('Keep this newer draft');
    await page.evaluate(() => window.__calendarEvent.releaseRead());
    await expect(ordinary.getByLabel('Title', { exact: true })).toHaveValue('Keep this newer draft');
    await expect(form(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__calendarEvent.creates)).toEqual([]);
    expect(await page.evaluate(() => window.__calendarEvent.writes)).toEqual([]);
  });

  test('preserves an existing copied draft and guards edits to the original', async ({ page }) => {
    await open(page, 'editable-google');
    await duplicate(page).click();
    await form(page).getByLabel('Title', { exact: true }).fill('Keep my reviewed copy');
    await duplicate(page).click();
    await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue('Keep my reviewed copy');
    await expect(form(page).getByLabel('Title', { exact: true })).toBeFocused();
    await detail(page).getByRole('button', { name: 'Edit event', exact: true }).click();
    await expect(form(page).getByRole('alertdialog', { name: 'Leave this event?', exact: true })).toBeVisible();
    await form(page).getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(form(page).getByLabel('Title', { exact: true })).toHaveValue('Keep my reviewed copy');
    await detail(page).getByRole('button', { name: 'Edit event', exact: true }).click();
    await form(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    await expect(page.locator('[data-calendar-event-field="summary"]')).toHaveValue('Customer planning');
    expect(await page.evaluate(() => window.__calendarEvent.writes)).toEqual([]);
  });

  test('allows retrying an interrupted source read and refuses a replacement calendar', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__calendarEvent.holdNextRead());
    await duplicate(page).click();
    await expect.poll(() => page.evaluate(() => window.__calendarEvent.readPending())).toBe(true);
    await page.evaluate(() => window.__calendarEvent.releaseRead(true));
    await expect(detail(page).getByRole('alert')).toContainText('interrupted');
    await expect(form(page)).toHaveCount(0);
    await duplicate(page).click(); await expect(form(page)).toBeVisible();
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await form(page).getByRole('button', { name: 'Discard draft', exact: true }).click();
    await page.evaluate(() => window.__calendarEvent.replaceCalendar());
    await duplicate(page).click();
    await expect(detail(page).getByRole('alert')).toContainText('changed');
    await expect(form(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__calendarEvent.creates)).toEqual([]);
    expect(await page.evaluate(() => window.__calendarEvent.writes)).toEqual([]);
  });

  test('keeps an exact duration through a repeated hour and previews overlaps with the original included', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__calendarEvent.setSpan(3_615_123));
    await duplicate(page).click();
    await form(page).getByLabel('Starts', { exact: true }).fill('2026-11-01T01:30');
    await expect(form(page).getByLabel('Ends', { exact: true })).toHaveValue('');
    await form(page).getByLabel('Which start time?', { exact: true }).selectOption(String(Date.parse('2026-11-01T08:30:00Z')));
    await expect(form(page).getByLabel('Ends', { exact: true })).toHaveValue('2026-11-01T01:30:15.123');
    await expect(form(page).getByLabel('Which end time?', { exact: true })).toHaveValue(String(Date.parse('2026-11-01T09:30:15.123Z')));
    await expect.poll(() => page.evaluate(() => window.__calendarOverlap.requests.at(-1)?.end_at)).toBe(Date.parse('2026-11-01T09:30:15.123Z'));
    const preview = await page.evaluate(() => window.__calendarOverlap.requests.at(-1));
    expect(preview?.exclude).toBeUndefined();
    await form(page).getByRole('button', { name: 'Create event', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    const created = await page.evaluate(() => window.__calendarEvent.creates);
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual(expect.objectContaining({ start_at: Date.parse('2026-11-01T08:30:00Z'), end_at: Date.parse('2026-11-01T09:30:15.123Z') }));
    expect(await page.evaluate(() => window.__calendarEvent.writes)).toEqual([]);
  });
});
