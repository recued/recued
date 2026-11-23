import { DAY_MS, RpcError, localDayAsDateOnly, zonedWallClockToEpochMs,
  type ProjectAttentionScope, type ProjectAttentionIssue, type WorkEntityProjectAttentionRpcRequest,
  type WorkEntityProjectAttentionRpcResponse, type TaskListFilter, type WorkEntity } from '@recued/contracts';
import type { WorkEntityCrudRpcDeps } from './work-entity-crud-handler.js';
import type { WorkEntityListQuery } from './storage/work-entity-store.js';
import { readThroughSourceIds } from './work-entity-read-resolution.js';
import { commitmentCounterparties } from './work-entity-contact-labels.js';

const scopes: readonly ProjectAttentionScope[] = ['overdue_tasks', 'due_soon_tasks', 'blocking_commitments'];
const brief = (value: string, size = 200) => { const text = value.replace(/\s+/gu, ' ').trim(); return text.slice(0, size) + (text.length > size ? '…' : ''); };
const identity = (row: { source_id: string; source_record_id?: string | null; created_at: number }) => JSON.stringify([row.source_id, row.source_record_id ?? null, row.created_at]);

/** Complete saved-project counts and a bounded drill-down from one SQLite
 * snapshot. Search text and the ordinary overview filters never enter here. */
export const handleWorkEntityProjectAttention = (
  deps: Pick<WorkEntityCrudRpcDeps, 'store' | 'resolver' | 'contactDisplay' | 'now'>,
  args: WorkEntityProjectAttentionRpcRequest,
): WorkEntityProjectAttentionRpcResponse => {
  if (!args || typeof args.project_id !== 'string' || !args.project_id.trim() || args.project_id.length > 2048
    || typeof args.time_zone !== 'string' || args.time_zone.length > 100 || !args.time_zone) throw new RpcError('bad_request', 'Choose a project and a valid time zone.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: args.time_zone }).format(); }
  catch { throw new RpcError('bad_request', 'Choose a valid time zone for project attention.'); }
  if (args.scope !== undefined && !scopes.includes(args.scope)) throw new RpcError('bad_request', 'Choose overdue tasks, upcoming tasks or blocking commitments.');
  const limit = args.limit ?? 10, offset = args.offset ?? 0, now = (deps.now ?? Date.now)(), at = args.as_of === undefined ? now : args.as_of;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0 || offset > 0 && !args.scope)
    throw new RpcError('bad_request', 'Attention pages need a limit of 1–50 and a non-negative offset for one scope.');
  if (!Number.isSafeInteger(at) || at > now || now - at > 15 * 60_000 || Math.abs(at) > 8.64e15 - 8 * DAY_MS)
    throw new RpcError('bad_request', 'This attention window expired. Refresh project attention before continuing.');
  if (args.project_identity !== undefined && (!args.project_identity || typeof args.project_identity !== 'object' || Array.isArray(args.project_identity) || typeof args.project_identity.source_id !== 'string' || !args.project_identity.source_id
    || !Number.isSafeInteger(args.project_identity.created_at) || args.project_identity.source_record_id != null && typeof args.project_identity.source_record_id !== 'string'))
    throw new RpcError('bad_request', 'The project identity could not be confirmed. Reopen the project.');
  const day = localDayAsDateOnly(at, args.time_zone), endDay = new Date(day + 7 * DAY_MS).toISOString().slice(0, 10);
  const before = zonedWallClockToEpochMs(endDay, args.time_zone);
  if (before === null || before <= at) throw new RpcError('bad_request', 'The project attention date window could not be resolved.');
  return deps.store.readSnapshot(() => {
    const project = deps.resolver.readEntity('project', args.project_id);
    const sources = deps.store.listSources(), excluded = readThroughSourceIds(sources);
    if (project?._kind !== 'project' || project.deleted_at != null || project.sync_state === 'orphaned' || project.sync_state === 'tombstoned'
      || excluded.has(project.source_id) || args.project_identity && identity(project) !== identity(args.project_identity))
      throw new RpcError('not_found', 'This project was removed or replaced. Reopen it before checking attention.');
    const base: WorkEntityListQuery = { excluded_source_ids: [...excluded], time_zone: args.time_zone };
    const task = (completion: 'all' | 'open' | 'completed', due: TaskListFilter['due'] = { kind: 'all' }): WorkEntityListQuery =>
      ({ ...base, parent_project_id: project.id, task_filter: { completion, due, sort: 'due_asc' } });
    const overdue = task('open', { kind: 'overdue', before: at });
    // Date-only dues retain today's whole day; timed dues earlier today are overdue, not upcoming.
    const upcoming = task('open', { kind: 'range', from: at, before });
    const blocking: WorkEntityListQuery = { ...base, blocks_project_id: project.id, commitment_filter: { direction: 'all', status: 'open' } };
    const counts = { open_tasks: deps.store.countByKind('task', task('open')), completed_tasks: deps.store.countByKind('task', task('completed')),
      overdue_tasks: deps.store.countByKind('task', overdue), due_soon_tasks: deps.store.countByKind('task', upcoming), blocking_commitments: deps.store.countByKind('commitment', blocking) };
    const issues: ProjectAttentionIssue[] = [];
    const add = (kind: ProjectAttentionIssue['kind'], source_label: string, reason: ProjectAttentionIssue['reason']) => {
      const item = { kind, source_label: brief(source_label), reason }; if (!issues.some(prior => prior.kind === kind && prior.source_label === item.source_label && prior.reason === reason)) issues.push(item);
    };
    const freshness = new Map(['project', 'task', 'commitment'].flatMap(kind => deps.resolver.sourceFreshness(kind as 'project' | 'task' | 'commitment') ?? []).map(row => [row.source_id, row]));
    for (const source of sources) {
      const kind = source.top_tier_kind; if (kind !== 'task' && kind !== 'commitment' && !(kind === 'project' && source.id === project.source_id)) continue;
      if (excluded.has(source.id)) { add(kind, source.source_label, 'provider_only'); continue; }
      const state = freshness.get(source.id);
      if (state && state.state !== 'local' && state.state !== 'fresh') add(kind, source.source_label, 'stale');
      if (state?.list_complete === false) add(kind, source.source_label, 'incomplete');
    }
    if (project.sync_state === 'stale_unreachable') add('project', sources.find(s => s.id === project.source_id)?.source_label ?? 'Project source', 'stale');
    if (project.pending_write) add('project', 'Project', 'pending_project');
    if (deps.store.countByKind('task', { ...task('all'), sync_states: ['stale_unreachable'] })) add('task', 'Saved tasks', 'stale');
    if (deps.store.countByKind('commitment', { ...blocking, sync_states: ['stale_unreachable'] })) add('commitment', 'Saved blocking commitments', 'stale');
    const kind = args.scope === 'blocking_commitments' ? 'commitment' : 'task';
    const query = args.scope === 'overdue_tasks' ? overdue : args.scope === 'due_soon_tasks' ? upcoming : blocking;
    const total = args.scope ? counts[args.scope] : 0;
    const entities: WorkEntity[] = args.scope ? deps.resolver.listByKind(kind, { ...query, limit, offset }) : [];
    const contacts = kind === 'commitment' ? commitmentCounterparties(entities, deps.contactDisplay) : {};
    const items = entities.map(entity => {
      if (entity._kind !== kind || entity._kind !== 'task' && entity._kind !== 'commitment') throw new Error('The attention page returned an unexpected record kind.');
      const source = sources.find(s => s.id === entity.source_id), state = freshness.get(entity.source_id);
      return { id: entity.id, title: brief(entity._kind === 'task' ? entity.title : entity.statement), excerpt: entity._kind === 'task' ? brief(entity.body ?? '', 180) : '',
        created_at: entity.created_at, ...(entity.source_record_id !== undefined ? { source_record_id: entity.source_record_id } : {}), source_id: entity.source_id,
        source_label: source?.source_label ?? 'Source unavailable', updated_at: entity.updated_at,
        stale: entity.sync_state === 'stale_unreachable' || state !== undefined && state.state !== 'local' && state.state !== 'fresh',
        ...(state?.list_complete === false ? { source_incomplete: true as const } : {}), pending_write: entity.pending_write !== undefined,
        ...(entity._kind === 'task' ? { done: entity.done, ...(entity.due_at !== undefined ? { due_at: entity.due_at } : {}) }
          : { commitment: { direction: entity.direction, lifecycle_state: entity.lifecycle_state, due_status: entity.due_status,
            ...(entity.promised_for_at !== undefined ? { promised_for_at: entity.promised_for_at } : {}),
            ...(entity.counterparty_contact_id ? { counterparty_label: contacts[entity.counterparty_contact_id] } : {}) } }) };
    });
    return { project, as_of: at, checked_at: now, time_zone: args.time_zone, upcoming_before: before, counts,
      coverage: { issues: issues.slice(0, 50), omitted: Math.max(0, issues.length - 50) }, ...(args.scope ? { scope: args.scope } : {}),
      items, offset, total, more: offset + items.length < total };
  });
};
