import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { WORK_ENTITY_KINDS, RECUED_BUILTIN_SOURCE_ID, type CalendarEventSnapshot, type WorkEntityUpsertRpcRequest } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../../../../backend/server/src/work-entity-crud-handler.js';

/** Calendar snapshots are read-only fixtures. Task search, creation and reads
 * use the real owner CRUD handlers and SQLite, including lost-reply cases. */
export const installCalendarTaskFixture = async (page: Page, allDay = false) => {
  const now = Date.parse('2026-10-28T12:00:00Z'); await page.clock.install({ time: new Date(now) });
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), bus = createWarehouseEventBus(), resolver = createWorkEntityResolver(store);
  for (const kind of WORK_ENTITY_KINDS) store.registerSource({ id: RECUED_BUILTIN_SOURCE_ID(kind), top_tier_kind: kind, source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: now });
  store.registerSource({ id: 'other.task', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'Other tasks', write_capable: true });
  const handlers = makeWorkEntityCrudHandlers({ store, resolver, dispatchers: createWorkEntityDispatchers({ store, resolver, bus, now: () => now + 1000 }) })!.handlers;
  const client = { instance_id: 'calendar-task-browser', client_kind: 'webclient' } as never;
  const snapshots = ['work', 'home'].map((slug, index): CalendarEventSnapshot => {
    const record_id = `cal:${slug}:shared-uid`, source_id = 'shared-uid';
    const event = { record_id, source_id, calendar_id: slug, calendar_name: index ? 'Personal' : 'Planning', summary: index ? 'Family planning' : allDay ? 'Team retreat' : 'Customer planning',
      description: allDay ? 'Only the retained beginning.' : 'Bring the launch agenda.', ...(allDay ? { description_truncated: true as const } : {}),
      location: 'Meeting room 2', updated_at: now, start_at: Date.parse(allDay ? '2026-10-31T00:00:00Z' : '2026-10-28T16:00:12.345Z'),
      end_at: Date.parse(allDay ? '2026-11-03T00:00:00Z' : '2026-10-28T17:00:12.345Z'), timezone: 'America/Los_Angeles', is_all_day: allDay, is_recurring: true, status: 'confirmed' as const };
    return { event, record: { record_id, source_id, received_at: now, modified_at: now, size_bytes: event.description.length,
      hot_fields: { summary: event.summary, location: event.location, start_at: event.start_at, end_at: event.end_at, is_all_day: event.is_all_day, status: event.status }, body_inline: event.description },
      resource_version: 'v1', incarnation: `${slug}-calendar-1`, editable: false, read_only_reason: 'Edit this event in its connected calendar.' };
  });
  const writes: WorkEntityUpsertRpcRequest[] = [], calendarWrites: string[] = [];
  let failSources = false, holdSources = false, release: (() => void) | undefined, reply: 'normal' | 'lost' | 'pending' = 'normal';
  await page.exposeFunction('__calendarTaskRpc', async (method: string, raw: Record<string, unknown>) => {
    const args = raw ?? {};
    try {
      if (/^collection\.calendar\.(?:event\.(?:create|update|respond|delete)|reschedule)/.test(method)) { calendarWrites.push(method); throw new Error('Unexpected calendar write.'); }
      if (method === 'work_entity.source.list') {
        if (holdSources) { holdSources = false; await new Promise<void>(done => { release = done; }); }
        if (failSources) throw new Error('Task Sources could not be loaded.'); return { result: { sources: store.listSources() } };
      }
      if (method === 'collection.listInstances') return { result: { instances: snapshots.map(snapshot => ({ platform: 'calendar', slug: snapshot.event.calendar_id,
        adapter_type: 'gcal', auth_state: 'healthy', caps: {}, last_synced_at: now })) } };
      const selected = snapshots.find(snapshot => snapshot.event.calendar_id === args.slug);
      if (method === 'collection.list' && args.platform === 'calendar') {
        const window = args.calendar_window as { from: number; before: number } | undefined, filters = args.filters as { is_all_day?: boolean } | undefined;
        return { result: { records: selected && (!window || selected.event.end_at > window.from && selected.event.start_at < window.before)
          && (filters?.is_all_day === undefined || filters.is_all_day === selected.event.is_all_day) ? [selected.record] : [],
          source_freshness: { last_success_at: now, stale: false, degraded: false, pending: 0 } } };
      }
      if (method === 'collection.get' && args.platform === 'calendar') return { result: { record: selected && selected.record.record_id === args.record_id ? selected.record : null } };
      if (method === 'collection.calendar.event.get') return { result: selected && selected.event.source_id === args.source_id ? structuredClone(selected) : null };
      const handler = handlers[method as keyof typeof handlers]; if (!handler) return undefined;
      if (method === 'work_entity.upsert') {
        writes.push(structuredClone(args) as unknown as WorkEntityUpsertRpcRequest);
        const result = await handler(args as never, client) as { entity: object };
        if (reply === 'lost') throw new Error('The task save reply was lost.');
        return { result: reply === 'pending' ? { ...result, entity: { ...result.entity, pending_write: { staged_at: now, operation: 'create', dirty_fields: ['title'], state: 'awaiting_verify' } } } : result };
      }
      return { result: await handler(args as never, client) };
    } catch (error) { return { error: { code: String((error as { code?: string }).code ?? 'unavailable'), message: error instanceof Error ? error.message : String(error) } }; }
  });
  await page.addInitScript(() => Object.assign(window, { __connectionsFixture: (method: string, args: unknown) =>
    (window as unknown as { __calendarTaskRpc(method: string, args: unknown): Promise<unknown> }).__calendarTaskRpc(method, args) }));
  return { writes, calendarWrites, tasks: () => store.listTasks(), snapshots,
    failSources: (value: boolean) => { failSources = value; },
    writable: (value: boolean) => { for (const id of ['recued.task', 'other.task']) store.registerSource({ id, top_tier_kind: 'task', source_kind: 'builtin', source_label: id, write_capable: value }); },
    reply: (value: typeof reply) => { reply = value; }, holdSources: () => { holdSources = true; }, waiting: () => release !== undefined,
    release: () => { const done = release; release = undefined; done?.(); },
    dispose() { release?.(); bus.dispose(); db.close(); } };
};
