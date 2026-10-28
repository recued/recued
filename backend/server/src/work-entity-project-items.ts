import { RpcError, type WorkEntityProjectItemsRpcRequest, type WorkEntityProjectItemsRpcResponse } from '@recued/contracts';
import type { WorkEntityCrudRpcDeps } from './work-entity-crud-handler.js';
import type { WorkEntityListQuery } from './storage/work-entity-store.js';
import { readThroughSourceIds } from './work-entity-read-resolution.js';

const preview = (value: string, size: number) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > size ? `${text.slice(0, size)}…` : text;
};

/** Explicit project membership in the complete local warehouse. Read-through
 * sources retain no local rows; residue is excluded before paging AND count. */
export const handleWorkEntityProjectItems = (
  deps: Pick<WorkEntityCrudRpcDeps, 'store' | 'resolver'>,
  args: WorkEntityProjectItemsRpcRequest,
): WorkEntityProjectItemsRpcResponse => {
  if (!args || typeof args.project_id !== 'string' || !args.project_id.trim()
    || args.kind !== 'task' && args.kind !== 'note') {
    throw new RpcError('bad_request', 'Choose a project and either tasks or notes.');
  }
  const limit = args.limit ?? 10, offset = args.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new RpcError('bad_request', 'Project pages require a limit of 1–50 and a non-negative offset.');
  }
  if (!deps.resolver.readEntity('project', args.project_id)) throw new RpcError('not_found', 'This project is no longer available.');
  const sources = deps.store.listSources();
  const excluded = readThroughSourceIds(sources);
  const filter: WorkEntityListQuery = { excluded_source_ids: [...excluded],
    ...(args.kind === 'task' ? { parent_project_id: args.project_id,
      task_filter: { completion: 'all', due: { kind: 'all' }, sort: 'default' } }
      : { related_project_id: args.project_id }) };
  const entities = deps.resolver.listByKind(args.kind, { ...filter, limit, offset });
  const total = deps.store.countByKind(args.kind, filter);
  const freshness = new Map((deps.resolver.sourceFreshness(args.kind) ?? []).map(row => [row.source_id, row]));
  const providerOnly = sources.filter(source => source.top_tier_kind === args.kind && excluded.has(source.id)).map(source => source.source_label);
  return { project_id: args.project_id, kind: args.kind, offset, total,
    ...(args.kind === 'task' ? { open_tasks: deps.store.countByKind('task', { ...filter,
      task_filter: { completion: 'open', due: { kind: 'all' }, sort: 'default' } }) } : {}),
    ...(providerOnly.length ? { provider_only_sources: providerOnly } : {}),
    items: entities.map(entity => {
      if (entity._kind !== 'task' && entity._kind !== 'note') throw new Error('Project work returned an unexpected kind.');
      const source = sources.find(row => row.id === entity.source_id), state = freshness.get(entity.source_id);
      return { id: entity.id, title: preview(entity.title?.trim() || 'Note', 200), excerpt: preview(entity.body ?? '', 180),
        source_id: entity.source_id, source_label: source?.source_label ?? 'Source unavailable', updated_at: entity.updated_at,
        stale: entity.sync_state === 'stale_unreachable' || state !== undefined && state.state !== 'local' && state.state !== 'fresh',
        ...(state?.list_complete === false ? { source_incomplete: true as const } : {}),
        pending_write: entity.pending_write !== undefined,
        ...(entity._kind === 'task' ? { done: entity.done, ...(entity.due_at !== undefined ? { due_at: entity.due_at } : {}) } : {}) };
    }) };
};
