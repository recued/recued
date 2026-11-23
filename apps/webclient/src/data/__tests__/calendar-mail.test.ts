import { describe, expect, it, vi } from 'vitest';
import { CALENDAR_EVENT_EDIT_LIMITS, type CalendarEventCreateRequest, type CalendarEventCreateResult, type MailMessageSnapshot } from '@recued/contracts';
import { calendarMailSeed, readCalendarMailOrigin } from '../calendar-mail.js';
import { createMailMessageSurface } from '../mail-message-surface.js';
import { createCalendarCreateSurface, CALENDAR_CREATE_FIELD } from '../calendar-create-surface.js';
import { createCalendarRecoveryStore, parseCalendarRecovery } from '../calendar-draft-recovery.js';

const message = (): MailMessageSnapshot => ({ slug: 'work/one', record_id: 'mail?#二', received_at: 1, subject: 'Review <the quote> & dates',
  from: 'alex@example.test', to: ['owner@example.test'], cc: ['private@example.test'], body: 'Private email body', body_truncated: true,
  read: 'stored', reply: null, state: { identity: 'mail-1', verified: true, is_read: true, is_flagged: false, can_mark: false, can_flag: false } });
const input = (name: string, value: string) => ({ getAttribute: (key: string) => key === CALENDAR_CREATE_FIELD ? name : null, value }) as unknown as HTMLElement;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const mailSurface = (get: (ref: { slug: string; record_id: string }) => Promise<MailMessageSnapshot>, existing?: () => boolean) => {
  const onCreateEvent = vi.fn();
  const surface = createMailMessageSurface({ document: { defaultView: null } as Document, actionAttr: 'data-action',
    render: vi.fn(), callers: { get }, onCreateEvent, onExistingEvent: existing });
  return { surface, onCreateEvent };
};
const createResult = (request: CalendarEventCreateRequest): CalendarEventCreateResult => ({
  slug: request.slug, ...(request.send_invitations ? { invitations_requested: true as const } : {}),
  snapshot: { incarnation: request.expected_incarnation, resource_version: 'v1', editable: false,
    record: { record_id: 'new', source_id: 'new', received_at: 1, modified_at: 1, size_bytes: 0, hot_fields: {} },
    event: { ...request, record_id: 'new', source_id: 'new', updated_at: 1, status: 'confirmed', is_recurring: false } },
});
const form = (recovery?: ReturnType<typeof createCalendarRecoveryStore>) => {
  const onCreated = vi.fn(), onMailCancelled = vi.fn(), create = vi.fn(async (request: CalendarEventCreateRequest) => createResult(request));
  const surface = createCalendarCreateSurface({ actionAttr: 'data-action', render: vi.fn(), recovery, now: () => Date.parse('2026-11-19T12:00Z'),
    context: () => ({ day: '2026-10-31', zone: 'America/New_York' }),
    callers: { create, destinations: async () => ({ destinations: [
      { slug: 'calendar', calendar_id: 'primary', name: 'Work', incarnation: 'calendar-1', provider: 'gcal', can_invite: true },
    ], unavailable: [] }) }, onCreated, onMailCancelled });
  return { surface, create, onCreated, onMailCancelled };
};
const loaded = async (surface: ReturnType<typeof createCalendarCreateSurface>) =>
  vi.waitFor(() => expect(surface.render()).not.toContain('Loading writable calendars'));

describe('calendar draft from email', () => {
  it('keeps only a reviewed subject and exact email link, removing client credentials and query parameters', () => {
    const source = message(), seed = calendarMailSeed(source, 'https://user:secret@recued.test/client/?token=private#chat');
    expect(seed.summary).toBe(source.subject);
    expect(seed.description).toBe('Original email: https://recued.test/client/#data/mail/record/work%2Fone/mail%3F%23%E4%BA%8C');
    expect(seed.location).toBe('');
    expect(JSON.stringify(seed)).not.toContain(source.body);
    for (const key of ['guests', 'to', 'cc', 'reply', 'start_at', 'end_at']) expect(seed).not.toHaveProperty(key);
    source.subject = 'Changed'; expect(seed.origin.label).toBe('Review <the quote> & dates');
  });
  it('normalizes single-line titles, handles absent subjects, and refuses invalid source metadata or oversized details', () => {
    expect(calendarMailSeed({ ...message(), subject: 'One\r\nTwo' }, 'https://recued.test/').summary).toBe('One Two');
    expect(calendarMailSeed({ ...message(), subject: '  ' }, 'https://recued.test/').summary).toBe('Event from email');
    expect(() => calendarMailSeed({ ...message(), subject: 'x'.repeat(CALENDAR_EVENT_EDIT_LIMITS.summary + 1) }, 'https://recued.test/')).toThrow('limits');
    expect(() => calendarMailSeed({ ...message(), received_at: -1 }, 'https://recued.test/')).toThrow('confirmed');
    expect(() => calendarMailSeed(message(), 'javascript:alert(1)')).toThrow('link');
    const origin = calendarMailSeed(message(), 'https://recued.test/').origin;
    expect(readCalendarMailOrigin({ ...origin, guests: ['hidden@example.test'] })).toBeNull();
    expect(readCalendarMailOrigin({ ...origin, conversation: { thread_id: 'x', incarnation: '' } })).toBeNull();
  });
  it('freshly checks a read-only email once before opening and leaves the original untouched', async () => {
    let fresh = message(), release!: (value: MailMessageSnapshot) => void;
    const get = vi.fn(async () => fresh);
    const { surface, onCreateEvent } = mailSurface(get);
    await surface.open({ slug: fresh.slug, record_id: fresh.record_id });
    get.mockImplementationOnce(() => new Promise(done => { release = done; }));
    surface.handleAction('mail-message-create-event'); surface.handleAction('mail-message-create-event');
    expect(get).toHaveBeenCalledTimes(2); expect(onCreateEvent).not.toHaveBeenCalled();
    fresh = { ...fresh, subject: 'Fresh subject' }; release(fresh);
    await vi.waitFor(() => expect(onCreateEvent).toHaveBeenCalledTimes(1));
    expect(onCreateEvent.mock.calls[0]![0]).toEqual(fresh);
    expect(onCreateEvent.mock.calls[0]![1]()).toBe(true); surface.dispose();
    expect(onCreateEvent.mock.calls[0]![1]()).toBe(false);
  });
  it('focuses an existing event draft without another source read', async () => {
    const get = vi.fn(async () => message()), existing = vi.fn(() => true);
    const { surface, onCreateEvent } = mailSurface(get, existing);
    await surface.open({ slug: message().slug, record_id: message().record_id });
    surface.handleAction('mail-message-create-event'); await tick();
    expect(existing).toHaveBeenCalledOnce(); expect(get).toHaveBeenCalledTimes(1); expect(onCreateEvent).not.toHaveBeenCalled(); surface.dispose();
  });
  for (const retired of ['navigate', 'dispose'] as const) it('ignores a late email check after ' + retired, async () => {
    let release!: (value: MailMessageSnapshot) => void;
    const get = vi.fn(async () => message()), { surface, onCreateEvent } = mailSurface(get);
    await surface.open({ slug: message().slug, record_id: message().record_id });
    get.mockImplementationOnce(() => new Promise(done => { release = done; }));
    surface.handleAction('mail-message-create-event');
    if (retired === 'dispose') surface.dispose();
    else await surface.open({ slug: 'other', record_id: 'other' });
    release(message()); await tick(); expect(onCreateEvent).not.toHaveBeenCalled(); surface.dispose();
  });
  it('refuses a replacement mailbox or record and allows an interrupted check to be retried', async () => {
    const get = vi.fn(async () => message()), { surface, onCreateEvent } = mailSurface(get);
    await surface.open({ slug: message().slug, record_id: message().record_id });
    get.mockRejectedValueOnce(new Error('Interrupted'));
    surface.handleAction('mail-message-create-event'); await vi.waitFor(() => expect(surface.render()).toContain('Interrupted'));
    get.mockResolvedValueOnce({ ...message(), state: { ...message().state!, identity: 'replacement' } });
    surface.handleAction('mail-message-create-event'); await vi.waitFor(() => expect(surface.render()).toContain('different identity'));
    expect(onCreateEvent).not.toHaveBeenCalled();
    surface.handleAction('mail-message-create-event'); await vi.waitFor(() => expect(onCreateEvent).toHaveBeenCalledOnce()); surface.dispose();
  });
  it('requires dates and explicitly added guests, then sends only calendar fields and returns source context separately', async () => {
    const seed = calendarMailSeed(message(), 'https://recued.test/'), { surface, create, onCreated } = form();
    surface.openFromMail(seed); await loaded(surface);
    expect(surface.render()).toContain('Event from email'); expect(surface.render()).toContain('Times in America/New_York');
    expect(surface.render()).not.toContain('private@example.test');
    surface.handleAction('calendar-create-save'); await tick(); expect(create).not.toHaveBeenCalled();
    surface.handleInput(input('start', '2026-11-02T09:00')); surface.handleInput(input('end', '2026-11-02T10:00'));
    surface.handleInput(input('guestQuery', 'alex@example.test')); surface.handleAction('calendar-create-guest-add');
    surface.handleAction('calendar-create-save');
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    const request = create.mock.calls[0]![0];
    expect(request).toMatchObject({ summary: seed.summary, description: seed.description, start_at: Date.parse('2026-11-02T14:00Z'),
      end_at: Date.parse('2026-11-02T15:00Z'), guests: [{ email: 'alex@example.test' }], send_invitations: true });
    expect(request).not.toHaveProperty('mail'); expect(request).not.toHaveProperty('origin');
    expect(onCreated).toHaveBeenCalledWith(createResult(request), undefined, seed.origin); surface.dispose();
  });
  it('preserves an existing ordinary or email draft when another email action opens', async () => {
    const seed = calendarMailSeed(message(), 'https://recued.test/'), { surface } = form();
    surface.open(); await loaded(surface); surface.handleInput(input('summary', 'Keep this'));
    expect(surface.openFromMail(seed)).toBe(false); expect(surface.render()).toContain('value="Keep this"');
    surface.handleAction('calendar-create-cancel'); surface.handleAction('calendar-create-discard');
    surface.openFromMail(seed); await loaded(surface); surface.handleInput(input('summary', 'Reviewed event'));
    expect(surface.openFromMail({ ...seed, summary: 'Replacement' })).toBe(false); expect(surface.render()).toContain('Reviewed event'); surface.dispose();
  });
  it('recovers an untouched mail draft at its source, retains the origin and discards only after confirmation', async () => {
    const rows = new Map<string, string>(), now = () => Date.parse('2026-11-19T12:00Z');
    const store = createCalendarRecoveryStore({ scope: 'mail', now, storage: { getItem: key => rows.get(key) ?? null,
      setItem: (key, value) => { rows.set(key, value); }, removeItem: key => { rows.delete(key); } } });
    const seed = calendarMailSeed(message(), 'https://recued.test/'), first = form(store).surface;
    first.openFromMail(seed); await loaded(first); first.flush(); first.dispose();
    const entry = store.list()[0]!; expect(entry.values.mail).toEqual(seed.origin);
    expect(parseCalendarRecovery({ ...entry, values: { ...entry.values, mail: { ...seed.origin, guests: [] } } }, now())).toBeNull();
    const { surface, onMailCancelled } = form(store);
    expect(surface.render({ kind: 'mail', slug: 'other', recordId: seed.origin.recordId })).not.toContain('Resume draft');
    expect(surface.render({ kind: 'mail', slug: seed.origin.slug, recordId: seed.origin.recordId })).toContain('Resume draft');
    surface.handleAction('calendar-create-recovery-resume', { getAttribute: () => entry.id } as unknown as HTMLElement); await loaded(surface);
    surface.handleAction('calendar-create-cancel'); expect(onMailCancelled).not.toHaveBeenCalled();
    surface.handleAction('calendar-create-discard'); expect(onMailCancelled).toHaveBeenCalledWith(seed.origin);
    expect(store.list()).toEqual([]); surface.dispose();
  });
});
