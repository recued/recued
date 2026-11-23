import type { Page } from '@playwright/test';
import type { CalendarEventSnapshot, CollectionRecord, MailMessageSnapshot } from '@recued/contracts';
import type { WorkEntityCrudRpcDeps } from '../../../../backend/server/src/work-entity-crud-handler.js';
import { installTaskReaderFixture } from './task-reader-fixture.js';

/** Native task CRUD with controlled mailbox/calendar reads. Both accounts have
 * matching provider ids so opening a source must retain the qualified address. */
export const installTaskNoteSourceFixture = async (page: Page, opts: { searchable?: boolean; caller?: (method: string, args: Record<string, unknown>) => unknown | Promise<unknown>;
  calendarSources?: { get(slug: string, id: string): CollectionRecord | null; incarnation(slug: string): string | null;
    linkedMail: NonNullable<NonNullable<WorkEntityCrudRpcDeps['sourceRecords']>['linkedCalendar']> } } = {}) => {
  const now = Date.parse('2026-10-31T18:00:00Z');
  const mailId = "message/shared?二.)!'*", eventId = 'cal:work:shared-uid/2026-11-01T09:30:12.345Z';
  const records = new Map<string, CollectionRecord>(), calendar = new Map<string, CalendarEventSnapshot>();
  const mailPatches = new Map<string, Partial<MailMessageSnapshot>>();
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [], mutations: string[] = [];
  const unavailableSources = new Set<string>();
  const failed = new Set<string>(), held = new Set<string>(), releases = new Map<string, () => void>();
  const key = (platform: string, slug: string, id: string) => JSON.stringify([platform, slug, id]);
  for (const slug of ['work', 'home']) {
    const row: CollectionRecord = { record_id: mailId, source_id: 'same-provider-message', received_at: now, modified_at: now, size_bytes: 20,
      hot_fields: { from: 'Riley <riley@example.test>', to: ['owner@example.test'], subject: slug === 'work' ? 'Exact work email' : 'Other mailbox email',
        thread_id: 'same-provider-thread', direction: 'inbound', folder: 'INBOX', is_read: true, is_flagged: false, has_attachments: false } };
    records.set(key('mail', slug, mailId), row);
    const event = { record_id: eventId, source_id: 'same-provider-event', calendar_id: slug, calendar_name: slug === 'work' ? 'Planning' : 'Personal',
      summary: slug === 'work' ? 'Exact work occurrence' : 'Other calendar occurrence', description: 'Keep the event context.', location: 'Meeting room 2', updated_at: now,
      start_at: Date.parse('2026-11-01T09:30:12.345Z'), end_at: Date.parse('2026-11-01T10:30:12.345Z'), timezone: 'America/Los_Angeles', is_all_day: false,
      is_recurring: true, status: 'confirmed' as const };
    const record: CollectionRecord = { record_id: eventId, source_id: event.source_id, received_at: now, modified_at: now, size_bytes: 20,
      hot_fields: { summary: event.summary, location: event.location, start_at: event.start_at, end_at: event.end_at, is_all_day: false, status: 'confirmed' }, body_inline: event.description };
    records.set(key('calendar', slug, eventId), record);
    calendar.set(slug, { event, record, resource_version: 'v1', incarnation: `${slug}-calendar-1`, editable: false, read_only_reason: 'Read-only calendar.' });
  }
  const callKey = (method: string, slug: string) => `${method}:${slug}`;
  const incarnations = new Map(['work', 'home'].flatMap(slug => [['mail:' + slug, slug + '-mail-1'], ['calendar:' + slug, slug + '-calendar-1']]));
  const tasks = await installTaskReaderFixture(page, { sourceRecords: {
    get: (platform, slug, id) => platform === 'calendar' && opts.calendarSources ? opts.calendarSources.get(slug, id) : records.get(key(platform, slug, id)) ?? null,
    getIncarnation: (platform, slug) => platform === 'calendar' && opts.calendarSources ? opts.calendarSources.incarnation(slug) : incarnations.get(platform + ':' + slug) ?? null,
    ...(opts.calendarSources ? { linkedCalendar: opts.calendarSources.linkedMail } : {}),
  } });
  tasks.fixtureCaller(async (method, args) => {
    if (opts.caller) { const reply = await opts.caller(method, args); if (reply !== undefined) return reply; }
    if (method === 'yours.today') return { error: { code: 'unknown_method', message: 'No proactive fixture.' } };
    if (method === 'yours.spheres') return { result: { placements: ((args.refs as object[]) ?? []).map(ref => ({ ref, sphere: 'professional', reason: 'Work task' })) } };
    if (method === 'contact.source.list') return { result: { sources: [] } };
    if (method === 'contact.contributions') return { result: { contributions: [] } };
    if (method === 'data.timeline') return { result: { entries: [] } };
    if (!method.startsWith('collection.')) return undefined;
    calls.push({ method, args: structuredClone(args) });
    const slug = String(args.slug ?? ''), entry = callKey(method, slug);
    if (held.delete(entry)) await new Promise<void>(resolve => releases.set(entry, resolve));
    if (failed.has(entry)) return { error: { code: 'unavailable', message: 'The source read was interrupted.' } };
    if (method === 'collection.searchAll' && opts.searchable) {
      const query = String(args.query ?? '').toLocaleLowerCase();
      const platforms = ['mail', 'calendar'].filter(platform => !Array.isArray(args.platforms) || args.platforms.includes(platform));
      const groups = platforms.flatMap(platform => ['work', 'home'].flatMap(slug => {
        if (unavailableSources.has(platform + ':' + slug)) return [];
        const matches = [...records.entries()].filter(([id, row]) => id.startsWith(JSON.stringify([platform, slug]).slice(0, -1) + ',')
          && JSON.stringify(row.hot_fields).toLocaleLowerCase().includes(query)).map(([, row]) => ({ record_id: row.record_id,
          hot_fields: row.hot_fields, received_at: row.received_at, body: row.body_inline, rank: -1 }));
        return matches.length ? [{ platform, slug, matches, more: false, source_freshness: { stale: false } }] : [];
      }));
      return { result: { groups, unavailable_sources: platforms.flatMap(platform => ['work', 'home'].filter(slug => unavailableSources.has(platform + ':' + slug)).map(slug => ({ platform, slug }))) } };
    }
    if (method === 'collection.listInstances') return { result: { instances: ['mail', 'calendar'].flatMap(platform => ['work', 'home'].map(value => ({ platform, slug: value,
      adapter_type: platform === 'mail' ? 'gmail' : 'gcal', auth_state: 'healthy', caps: {}, last_synced_at: now }))) } };
    if (method === 'collection.mail.list') return { result: { instances: ['work', 'home'].map(value => ({ slug: value, adapter_type: 'gmail', account_email: 'owner@example.test', send_capable: true, draft_capable: true, receive_capable: true, sent_lookup_capable: true, auth_state: 'healthy', caps: {} })) } };
    if (method === 'collection.list') return { result: { records: [...records.entries()].filter(([id]) => id.startsWith(JSON.stringify([args.platform, slug]).slice(0, -1)+',')).map(([, row]) => row) } };
    if (method === 'collection.get') return { result: { record: records.get(key(String(args.platform), slug, String(args.record_id))) ?? null } };
    const mail = records.get(key('mail', slug, String(args.record_id)));
    if (method === 'collection.mail.conversation.get') {
      if (!mail) return { error: { code: 'not_found', message: 'The email is no longer available.' } };
      const message = { ...mail, ...mail.hot_fields, snippet: 'Exact email context.', has_attachments: false };
      return { result: { slug, anchor: message, messages: [message], thread_id: 'same-provider-thread', incarnation: incarnations.get('mail:' + slug)!, mailbox_address: 'owner@example.test' } };
    }
    if (method === 'collection.mail.message.get') {
      if (!mail) return { error: { code: 'not_found', message: 'The email is no longer available.' } };
      const conversation = { thread_id: 'same-provider-thread', incarnation: incarnations.get('mail:' + slug)! };
      const expected = args.conversation as typeof conversation | undefined;
      if (expected && (expected.thread_id !== conversation.thread_id || expected.incarnation !== conversation.incarnation))
        return { error: { code: 'resource_changed', message: 'The original email or mailbox changed.' } };
      const result: MailMessageSnapshot = { slug, record_id: mail.record_id, from: 'riley@example.test', to: ['owner@example.test'], cc: [],
        subject: String(mail.hot_fields.subject), received_at: now, body: slug === 'work' ? 'Exact work email body.' : 'Other account body.', body_truncated: false, read: 'stored',
        conversation,
        reply: { original_source_id: slug, original_message: { id: '<message@example.test>', from: 'riley@example.test', subject: String(mail.hot_fields.subject), body: 'Exact email context.' } } };
      return { result: { ...result, ...mailPatches.get(slug) } };
    }
    if (method === 'collection.mail.message.attachments') return { result: { slug, record_id: args.record_id, incarnation: incarnations.get('mail:' + slug)!, items: [], warnings: [], truncated: false } };
    if (method === 'collection.calendar.event.get') {
      const selected = calendar.get(slug);
      return { result: selected && selected.event.source_id === args.source_id ? structuredClone(selected) : null };
    }
    if (/^collection\.(?:mail\..*update|calendar\..*(?:create|update|respond|delete|reschedule))/.test(method)) mutations.push(method);
    return { error: { code: 'unknown_method', message: 'This source operation is unavailable in the fixture.' } };
  });
  return { ...tasks, calls, mutations, mailId, eventId,
    source: (tab: 'mail' | 'calendar', slug = 'work') => ({ tab, collectionSlug: slug, recordId: tab === 'mail' ? mailId : eventId }),
    replaceSourceRecord: (tab: 'mail' | 'calendar', slug = 'work') => { const id = tab === 'mail' ? mailId : eventId; const row = records.get(key(tab, slug, id))!; records.set(key(tab, slug, id), { ...row, received_at: now + 5000 }); },
    failSearchAccount: (tab: 'mail' | 'calendar', slug: string, value = true) => { const scope = tab + ':' + slug; if (value) unavailableSources.add(scope); else unavailableSources.delete(scope); },
    replaceMail: () => incarnations.set('mail:work', 'replacement-mail'),
    replaceCalendar: () => { incarnations.set('calendar:work', 'replacement-calendar'); const value = calendar.get('work')!; calendar.set('work', { ...value, incarnation: 'replacement-calendar' }); },
    updateMail: (slug: string, patch: Partial<MailMessageSnapshot>) => mailPatches.set(slug, { ...mailPatches.get(slug), ...patch }),
    updateCalendar: (slug: string, patch: Partial<CalendarEventSnapshot['event']>) => { const value = calendar.get(slug)!; calendar.set(slug, { ...value, event: { ...value.event, ...patch } }); },
    editableCalendar: () => { const value = calendar.get('work')!; calendar.set('work', { ...value, editable: true, provider_verified: true, editable_fields: ['summary', 'location', 'description'] }); },
    remove: (platform: string, slug: string, id: string) => records.delete(key(platform, slug, id)),
    wrongRecord: () => { const row = records.get(key('mail', 'work', mailId))!; records.set(key('mail', 'work', mailId), { ...row, record_id: 'different-message' }); },
    failSource: (method: string, slug: string, value = true) => { if (value) failed.add(callKey(method, slug)); else failed.delete(callKey(method, slug)); },
    holdSource: (method: string, slug: string) => held.add(callKey(method, slug)), sourceWaiting: () => releases.size > 0,
    releaseSource: () => { for (const resolve of releases.values()) resolve(); releases.clear(); },
    dispose() { for (const resolve of releases.values()) resolve(); releases.clear(); tasks.dispose(); } };
};
