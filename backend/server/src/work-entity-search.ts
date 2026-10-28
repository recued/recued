import {
  RpcError, WORK_ENTITY_SEARCH_KINDS,
  type WorkEntity, type WorkEntitySearchGroup, type WorkEntitySearchKind,
  type WorkEntitySearchRpcRequest, type WorkEntitySearchRpcResponse,
} from '@recued/contracts';
import type { WorkEntityStore } from './storage/work-entity-store.js';
import type { WorkEntityResolver } from './work-entity-resolver.js';
import { readThroughSourceIds } from './work-entity-read-resolution.js';

const labels: Record<WorkEntitySearchKind, string> = {
  task: 'Tasks', note: 'Notes', project: 'Projects', commitment: 'Commitments',
};
const preview = (text: string, length: number): string => {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > length ? `${compact.slice(0, length)}…` : compact;
};
const textOf = (entity: WorkEntity): { title: string; text: string } => {
  switch (entity._kind) {
    case 'task': return { title: entity.title, text: entity.body ?? '' };
    case 'note': return { title: entity.title?.trim() || 'Note', text: entity.body };
    case 'project': return { title: entity.title, text: entity.description ?? '' };
    case 'commitment': return { title: entity.statement, text: '' };
    default: throw new Error('Unsupported work search kind');
  }
};

/** The same durable index as work.search. This paired-owner read never polls a
 * provider or filters the first loaded list page. Each kind can fail alone. */
export const handleWorkEntitySearch = (
  deps: { store: WorkEntityStore; resolver: WorkEntityResolver },
  args: WorkEntitySearchRpcRequest,
): WorkEntitySearchRpcResponse => {
  if (args == null || typeof args.query !== 'string') throw new RpcError('bad_request', 'Search text must be a string.');
  if (args.kind !== undefined && !(WORK_ENTITY_SEARCH_KINDS as readonly unknown[]).includes(args.kind)) {
    throw new RpcError('bad_request', 'Choose Tasks, Notes, Projects or Commitments.');
  }
  const limit = args.limit ?? 5;
  const offset = args.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 0 && args.kind === undefined) {
    throw new RpcError('bad_request', 'Search pages need a limit of 1–50 and a non-negative offset for one kind.');
  }
  const query = args.query.trim();
  if (!query) return { groups: [] };
  const kinds = args.kind === undefined ? WORK_ENTITY_SEARCH_KINDS : [args.kind];
  return { groups: kinds.map((kind): WorkEntitySearchGroup => {
    try {
      const entities = deps.store.searchPageByText(kind, query, {
        limit: limit + 1, offset, exclude_source_ids: [...readThroughSourceIds(deps.store.listSources())],
      });
      const freshness = new Map((deps.resolver.sourceFreshness(kind) ?? []).map(value => [value.source_id, value]));
      const matches = entities.slice(0, limit).map(entity => {
        const { title, text } = textOf(entity);
        const state = freshness.get(entity.source_id)?.state;
        return { id: entity.id, title: preview(title, 120), excerpt: preview(text, 180),
          source_id: entity.source_id, source_label: deps.store.getSource(entity.source_id)?.source_label ?? 'Source unavailable',
          updated_at: entity.updated_at, stale: entity.sync_state === 'stale_unreachable'
            || state !== undefined && state !== 'local' && state !== 'fresh',
          ...(freshness.get(entity.source_id)?.list_complete === false ? { source_incomplete: true as const } : {}),
          pending_write: entity.pending_write !== undefined };
      });
      return { kind, matches, more: entities.length > limit, offset };
    } catch {
      return { kind, matches: [], more: false, offset, error: `${labels[kind]} could not be searched. Try again.` };
    }
  }) };
};
