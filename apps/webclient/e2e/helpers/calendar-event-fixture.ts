import type { Page } from '@playwright/test';
import type { CalendarEventSnapshot, CalendarEventUpdateRequest, CalendarEventRespondRequest, CollectionRecord } from '@recued/contracts';

/** Local RPC fixture. Clone every reply, as a real WebSocket boundary does. */
export const installCalendarEventFixture = async (page: Page, mode: 'timed' | 'all-day' | 'connected' | 'invitation' = 'timed', agenda = false): Promise<void> => {
  await page.addInitScript(({ mode, agenda }) => {
    const connected = mode === 'connected' || mode === 'invitation';
    const slug = connected ? 'work' : 'local';
    const day = mode === 'all-day';
    let version = 1;
    let saved: Omit<CalendarEventSnapshot, 'record'> = {
      event: { record_id: `cal:${slug}:event-1`, source_id: 'event-1', calendar_id: slug, calendar_name: day ? 'Holidays' : 'Planning',
        updated_at: 1_700_000_000_000, summary: day ? 'Team retreat' : 'Customer planning', description: '\nBring the launch agenda.', location: 'Meeting room 2',
        start_at: Date.parse(day ? '2026-10-31T00:00:00Z' : '2026-10-28T16:00:12.345Z'),
        end_at: Date.parse(day ? '2026-11-03T00:00:00Z' : '2026-10-28T17:00:12.345Z'),
        timezone: 'America/Los_Angeles', is_all_day: day, status: 'confirmed', is_recurring: false },
      resource_version: 'v1', incarnation: 'local-calendar-1', editable: !connected,
      ...(connected ? { read_only_reason: 'Edit this event in its connected calendar.' } : {}),
    };
    if (mode === 'invitation') saved.invitation = { organizer: { email: 'host@example.com', display_name: 'Customer host' },
      attendee_email: 'me@example.com', response: 'needs_action', can_respond: true, scope: 'event' };
    if (mode === 'invitation') saved.provider_verified = true;
    let readAvailable = true;
    const responses: CalendarEventRespondRequest[] = [];
    let removeOnDecline = false;
    let next: 'fail' | 'lost' | 'hold' | null = null;
    let release: ((fail: boolean) => void) | undefined;
    let holdRead = false;
    let releaseRead: ((fail: boolean) => void) | undefined;
    const writes: CalendarEventUpdateRequest[] = [];
    const record = () => ({ record_id: saved.event.record_id, source_id: saved.event.source_id, received_at: 1_700_000_000_000,
      modified_at: 1_700_000_000_000 + version, size_bytes: saved.event.description.length,
      hot_fields: { summary: saved.event.summary, location: saved.event.location, start_at: saved.event.start_at, end_at: saved.event.end_at,
        is_all_day: saved.event.is_all_day, status: saved.event.status }, body_inline: saved.event.description });
    const view = (): CalendarEventSnapshot => structuredClone({ ...saved, record: record() });
    const extra = (id: string, summary: string, start: string | number, end: string | number, is_all_day = false): CollectionRecord => ({
      record_id: id, source_id: id, received_at: 1, modified_at: 1, size_bytes: 0,
      hot_fields: { summary, start_at: typeof start === 'string' ? Date.parse(start) : start,
        end_at: typeof end === 'string' ? Date.parse(end) : end, is_all_day, status: 'confirmed' },
    });
    const localRows = agenda ? [
      ...Array.from({ length: 103 }, (_, index) => extra(`page-${index}`, `Planning slot ${index + 1}`,
        Date.parse('2026-10-29T16:00:00Z') + index * 60_000, Date.parse('2026-10-29T16:01:00Z') + index * 60_000)),
      extra('retreat', 'Team retreat', '2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z', true),
      extra('overnight', 'Overnight handover', '2026-11-01T06:30:00Z', '2026-11-01T10:30:00Z'),
    ] : [];
    const remoteRows = agenda ? [extra('remote', 'Remote planning', '2026-11-06T17:00:00Z', '2026-11-06T18:00:00Z')] : [];
    const reads: { slug: string; offset: number; from: number; before: number; allDay: boolean }[] = [];
    let failSource: string | null = null, holdSource: string | null = null;
    let releaseList: (() => void) | undefined;
    const agendaControls = { reads,
      fail(slug: string | null) { failSource = slug; },
      holdNext(slug: string) { holdSource = slug; },
      pending() { return releaseList !== undefined; },
      release() { if (!releaseList) throw new Error('No agenda read is waiting.'); const done = releaseList; releaseList = undefined; done(); },
    };
    const controls = { writes, responses,
      setReadAvailable(available: boolean) { readAvailable = available; },
      removeOnDecline() { removeOnDecline = true; },
      allowResponses(allowed: boolean) { if (saved.invitation) { saved.invitation.can_respond = allowed; saved.invitation.unavailable_reason = allowed ? '' : 'This calendar is read-only.'; } },
      failNextSave() { next = 'fail'; }, loseNextReply() { next = 'lost'; }, holdNextSave() { next = 'hold'; },
      releaseSave(fail = false) { if (!release) throw new Error('No calendar save is waiting.'); const done = release; release = undefined; done(fail); },
      holdNextRead() { holdRead = true; },
      readPending() { return releaseRead !== undefined; },
      releaseRead(fail = false) { if (!releaseRead) throw new Error('No calendar read is waiting.'); const done = releaseRead; releaseRead = undefined; done(fail); },
      changeSavedTitle(title: string) { saved.event.summary = title; saved.resource_version = `v${++version}`; },
      saved: view,
    };
    Object.assign(window, { __calendarEvent: controls, __calendarAgenda: agendaControls, __connectionsFixture: async (method: string, raw: unknown) => {
      const args = raw as Record<string, unknown> | undefined;
      if (method === 'collection.listInstances') return { result: { instances: [{
        slug, platform: 'calendar', adapter_type: connected ? 'gcal' : 'local', caps: {}, auth_state: 'healthy', last_synced_at: 1_700_000_000_000,
      }, ...(agenda ? [{ slug: 'work', platform: 'calendar', adapter_type: 'gcal', caps: {}, auth_state: 'healthy', last_synced_at: Date.now() }] : [])] } };
      if (method === 'collection.list' && args?.platform === 'calendar') {
        const range = args.calendar_window as { from: number; before: number } | undefined;
        const filters = args.filters as { is_all_day?: boolean } | undefined;
        const offset = typeof args.offset === 'number' ? args.offset : 0;
        const limit = typeof args.limit === 'number' ? args.limit : 100;
        reads.push({ slug: String(args.slug), offset, from: range?.from ?? 0, before: range?.before ?? 0, allDay: filters?.is_all_day === true });
        if (holdSource === args.slug) { holdSource = null; await new Promise<void>(done => { releaseList = done; }); }
        if (failSource === args.slug) return { error: { code: 'unavailable', message: 'Calendar service unavailable.' } };
        const rows = args.slug === slug ? [record(), ...localRows] : args.slug === 'work' ? remoteRows : [];
        const matches = rows.filter(row => (!filters || row.hot_fields.is_all_day === filters.is_all_day)
          && (!range || (Number(row.hot_fields.start_at) < range.before && Number(row.hot_fields.end_at) > range.from)))
          .sort((a, b) => Number(a.hot_fields.start_at) - Number(b.hot_fields.start_at) || a.record_id.localeCompare(b.record_id));
        return { result: { records: structuredClone(matches.slice(offset, offset + limit)),
          source_freshness: { last_success_at: Date.now(), age_ms: 0, degraded: false, pending: 0, stale: false } } };
      }
      if (method === 'collection.get' && args?.platform === 'calendar') return { result: { record: args.record_id === saved.event.record_id ? structuredClone(record()) : null } };
      if (method === 'collection.calendar.event.get') {
        if (args?.slug !== slug || args.source_id !== saved.event.source_id) throw new Error('Wrong fixture calendar event identity.');
        if (holdRead) {
          holdRead = false;
          if (await new Promise<boolean>(done => { releaseRead = done; })) return { error: { code: 'unavailable', message: 'The event read was interrupted.' } };
        }
        const value = view();
        if (!readAvailable) {
          delete value.provider_verified;
          value.refresh_error = 'The calendar could not be refreshed. Showing the last synced details.';
          if (value.invitation) { value.invitation.can_respond = false; value.invitation.unavailable_reason = 'Organizer notification could not be verified.'; }
        }
        return { result: value };
      }
      if (method === 'collection.calendar.event.respond') {
        const request = raw as CalendarEventRespondRequest; responses.push(structuredClone(request));
        const behavior = next; next = null;
        const interrupted = behavior === 'hold' && await new Promise<boolean>(done => { release = done; });
        if (behavior === 'fail' || interrupted) return { error: { code: 'unavailable', message: 'The response was interrupted.' } };
        if (request.expected_version !== saved.resource_version || request.expected_incarnation !== saved.incarnation || !saved.invitation?.can_respond) {
          return { error: { code: 'resource_changed', message: 'The invitation changed before responding.' } };
        }
        saved.invitation.response = request.response; saved.resource_version = `v${++version}`;
        if (behavior === 'lost') return { error: { code: 'timeout', message: 'The response reply was lost.' } };
        return { result: removeOnDecline && request.response === 'declined'
          ? { removed: true, source_id: saved.event.source_id, response: 'declined' }
          : { removed: false, snapshot: view() } };
      }
      if (method === 'collection.calendar.event.update') {
        const request = raw as CalendarEventUpdateRequest; writes.push(structuredClone(request));
        const behavior = next; next = null;
        const interrupted = behavior === 'hold' && await new Promise<boolean>(done => { release = done; });
        if (behavior === 'fail' || interrupted) return { error: { code: 'unavailable', message: 'The calendar save was interrupted.' } };
        if (request.expected_version !== saved.resource_version || request.expected_incarnation !== saved.incarnation) {
          return { error: { code: 'resource_changed', message: 'The event changed since you opened it. Your draft is kept.' } };
        }
        saved = { ...saved, resource_version: `v${++version}`, event: { ...saved.event, ...request.patch, updated_at: 1_700_000_000_000 + version } };
        if (behavior === 'lost') return { error: { code: 'timeout', message: 'The save reply was lost.' } };
        return { result: view() };
      }
      if (method === 'data.timeline') return { result: { entries: [] } };
      return undefined;
    } });
  }, { mode, agenda });
};

declare global { interface Window { __calendarEvent: {
  writes: CalendarEventUpdateRequest[];
  responses: CalendarEventRespondRequest[];
  setReadAvailable(available: boolean): void;
  removeOnDecline(): void; allowResponses(allowed: boolean): void;
  failNextSave(): void; loseNextReply(): void; holdNextSave(): void; releaseSave(fail?: boolean): void;
  holdNextRead(): void; releaseRead(fail?: boolean): void; readPending(): boolean;
  changeSavedTitle(title: string): void; saved(): CalendarEventSnapshot;
} } }
declare global { interface Window { __calendarAgenda: {
  reads: { slug: string; offset: number; from: number; before: number; allDay: boolean }[];
  fail(slug: string | null): void; holdNext(slug: string): void; pending(): boolean; release(): void;
} } }
