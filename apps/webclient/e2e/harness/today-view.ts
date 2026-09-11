import type { CollectionRecord, SourceRegistration, WorkEntity } from '@recued/contracts';

const NOW = Date.parse('2026-09-08T12:00:00-07:00');
const HOUR = 3_600_000;
const source = (kind: 'task' | 'commitment'): SourceRegistration => ({
  id: `recued.${kind}`, top_tier_kind: kind, source_kind: 'builtin', source_label: 'Recued',
  write_capable: true, registered_at: NOW,
});
const base = { sync_state: 'live', conflict_policy: 'source_wins', last_seen_at: NOW, created_at: NOW, updated_at: NOW } as const;
const task = (id: string, title: string, due_at: number): WorkEntity => ({ ...base,
  _kind: 'task', id, title, source_id: 'recued.task', due_at, done: false, blocks_task_ids: [],
});
const entities: WorkEntity[] = [
  task('late/task', 'Send the proposal', NOW - HOUR),
  task('task-today', 'Review the brief', NOW + HOUR),
  task('task-tomorrow', 'Prepare the demo', NOW + 24 * HOUR),
  { ...base, _kind: 'commitment', id: 'promise', source_id: 'recued.commitment', statement: 'Deliver the draft to Maya',
    direction: 'outbound', promised_at: NOW, promised_for_at: NOW + 2 * HOUR, lifecycle_state: 'pending',
    due_status: 'due_soon', expiry_policy: 'escalate_overdue', state_changed_at: NOW,
    lifecycle_changed_at: NOW, due_status_changed_at: NOW, derivation: 'user_declared', blocks_task_ids: [], blocks_project_ids: [],
  },
];
const records: CollectionRecord[] = [
  { record_id: 'cal:event/one', source_id: 'original-event', received_at: NOW, modified_at: NOW, size_bytes: 0,
    hot_fields: { summary: 'Design review', start_at: NOW + 3 * HOUR, end_at: NOW + 4 * HOUR, status: 'confirmed', is_all_day: false } },
  { record_id: 'cal:offsite', source_id: 'offsite', received_at: NOW, modified_at: NOW, size_bytes: 0,
    hot_fields: { summary: 'Team offsite', start_at: Date.parse('2026-09-08T00:00:00Z'), end_at: Date.parse('2026-09-09T00:00:00Z'), status: 'confirmed', is_all_day: true } },
];
export const todayDemoReply = (method: string, raw: unknown): { result?: unknown; error?: { code: string; message: string } } | null => {
  const params = new URLSearchParams(location.search);
  if (params.get('data') !== 'today') return null;
  const args = raw as { kind?: string; id?: string; slug?: string; record_id?: string; offset?: number; limit?: number; calendar_window?: { from: number; before: number }; filters?: { is_all_day?: boolean } };
  if (method === 'work_entity.source.list') return { result: { sources: [source('task'), source('commitment')] } };
  if (method === 'work_entity.list') {
    const rows = entities.filter((entity) => entity._kind === args.kind && entity.id !== document.documentElement.dataset.todayHideTask);
    return { result: { entities: rows.slice(args.offset ?? 0, (args.offset ?? 0) + 1), total: rows.length } };
  }
  if (method === 'work_entity.get') return { result: { entity: entities.find((entity) => entity.id === args.id) ?? null } };
  if (method === 'collection.listInstances') return { result: { instances: [
    { platform: 'calendar', slug: 'work-calendar', adapter_type: 'gcal', auth_state: 'healthy', caps: {}, last_synced_at: NOW - 48 * HOUR },
  ] } };
  if (method === 'collection.list') {
    if (params.get('today_failure') === '1') return { error: { code: 'UNAVAILABLE', message: 'Calendar is unavailable.' } };
    const rows = records.filter((record) => (args.calendar_window === undefined ||
      (Number(record.hot_fields.end_at) > args.calendar_window.from && Number(record.hot_fields.start_at) < args.calendar_window.before))
      && (args.filters?.is_all_day === undefined || args.filters.is_all_day === record.hot_fields.is_all_day));
    return { result: { records: rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100)),
      source_freshness: { last_success_at: NOW - 48 * HOUR, age_ms: 48 * HOUR, pending: 0, degraded: false, stale: true } } };
  }
  if (method === 'collection.get') return { result: { record: records.find((record) => record.record_id === args.record_id) ?? null } };
  if (method === 'data.timeline') return { result: { entries: [] } };
  return null;
};
