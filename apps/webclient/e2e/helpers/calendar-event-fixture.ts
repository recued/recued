import type { Page } from '@playwright/test';
import type { CalendarEventSnapshot, CalendarEventUpdateRequest } from '@recued/contracts';

/** Local RPC fixture. Clone every reply, as a real WebSocket boundary does. */
export const installCalendarEventFixture = async (page: Page, mode: 'timed' | 'all-day' | 'connected' = 'timed'): Promise<void> => {
  await page.addInitScript(({ mode }) => {
    const slug = mode === 'connected' ? 'work' : 'local';
    const day = mode === 'all-day';
    let version = 1;
    let saved: Omit<CalendarEventSnapshot, 'record'> = {
      event: { record_id: `cal:${slug}:event-1`, source_id: 'event-1', calendar_id: slug, calendar_name: day ? 'Holidays' : 'Planning',
        updated_at: 1_700_000_000_000, summary: day ? 'Team retreat' : 'Customer planning', description: '\nBring the launch agenda.', location: 'Meeting room 2',
        start_at: Date.parse(day ? '2026-10-31T00:00:00Z' : '2026-10-28T16:00:12.345Z'),
        end_at: Date.parse(day ? '2026-11-03T00:00:00Z' : '2026-10-28T17:00:12.345Z'),
        timezone: 'America/Los_Angeles', is_all_day: day, status: 'confirmed', is_recurring: false },
      resource_version: 'v1', incarnation: 'local-calendar-1', editable: mode !== 'connected',
      ...(mode === 'connected' ? { read_only_reason: 'Edit this event in its connected calendar.' } : {}),
    };
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
    const controls = { writes,
      failNextSave() { next = 'fail'; }, loseNextReply() { next = 'lost'; }, holdNextSave() { next = 'hold'; },
      releaseSave(fail = false) { if (!release) throw new Error('No calendar save is waiting.'); const done = release; release = undefined; done(fail); },
      holdNextRead() { holdRead = true; },
      readPending() { return releaseRead !== undefined; },
      releaseRead(fail = false) { if (!releaseRead) throw new Error('No calendar read is waiting.'); const done = releaseRead; releaseRead = undefined; done(fail); },
      changeSavedTitle(title: string) { saved.event.summary = title; saved.resource_version = `v${++version}`; },
      saved: view,
    };
    Object.assign(window, { __calendarEvent: controls, __connectionsFixture: async (method: string, raw: unknown) => {
      const args = raw as Record<string, unknown> | undefined;
      if (method === 'collection.listInstances') return { result: { instances: [{
        slug, platform: 'calendar', adapter_type: mode === 'connected' ? 'gcal' : 'local', caps: {}, auth_state: 'healthy', last_synced_at: 1_700_000_000_000,
      }] } };
      if (method === 'collection.list' && args?.platform === 'calendar') return { result: { records: [structuredClone(record())] } };
      if (method === 'collection.get' && args?.platform === 'calendar') return { result: { record: args.record_id === saved.event.record_id ? structuredClone(record()) : null } };
      if (method === 'collection.calendar.event.get') {
        if (args?.slug !== slug || args.source_id !== saved.event.source_id) throw new Error('Wrong fixture calendar event identity.');
        if (holdRead) {
          holdRead = false;
          if (await new Promise<boolean>(done => { releaseRead = done; })) return { error: { code: 'unavailable', message: 'The event read was interrupted.' } };
        }
        return { result: view() };
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
  }, { mode });
};

declare global { interface Window { __calendarEvent: {
  writes: CalendarEventUpdateRequest[];
  failNextSave(): void; loseNextReply(): void; holdNextSave(): void; releaseSave(fail?: boolean): void;
  holdNextRead(): void; releaseRead(fail?: boolean): void; readPending(): boolean;
  changeSavedTitle(title: string): void; saved(): CalendarEventSnapshot;
} } }
