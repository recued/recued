import { contactLinkedFromTarget } from './contact-linked-from-target.js';
import { RpcError, savedWorkAddress, savedWorkLinks, savedWorkLinkMatches, savedWorkLinkIndexId,
  type WorkEntityLinkedFromRpcRequest, type WorkEntityLinkedFromRpcResponse } from '@recued/contracts';
import type { WorkEntityCrudRpcDeps } from './work-entity-crud-handler.js';
import { readThroughSourceIds } from './work-entity-read-resolution.js';

export const handleWorkEntityLinkedFrom = (
  deps: Pick<WorkEntityCrudRpcDeps, 'store' | 'resolver' | 'contactDisplay' | 'sourceRecords'>,
  args: WorkEntityLinkedFromRpcRequest,
): WorkEntityLinkedFromRpcResponse => {
  const target = typeof args?.url === 'string' && args.url.length <= 8192 ? savedWorkAddress(args.url) : null;
  if (!target?.client) throw new RpcError('bad_request', 'Choose an exact saved record link.');
  const limit = args.limit ?? 10, offset = args.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new RpcError('bad_request', 'Linked records need a limit of 1–50 and a non-negative offset.');
  }
  const calendarOffset = args.calendar_offset ?? 0;
  if (!Number.isSafeInteger(calendarOffset) || calendarOffset < 0 || calendarOffset > Number.MAX_SAFE_INTEGER - limit - 1) {
    throw new RpcError('bad_request', 'Choose a valid calendar-link page.');
  }
  let contactTarget: WorkEntityLinkedFromRpcResponse['contact_target'];
  let sourceTarget: WorkEntityLinkedFromRpcResponse['source_target'];
  if (target.kind === 'mail' || target.kind === 'calendar') {
    if (!deps.sourceRecords || !target.collection_slug) throw new RpcError('not_configured', 'Source record links cannot be read here.');
    const record = deps.sourceRecords.get(target.kind, target.collection_slug, target.id);
    if (!record || record.record_id !== target.id) throw new RpcError('not_found', 'This record is no longer available.');
    sourceTarget = { source_id: record.source_id, received_at: record.received_at,
      incarnation: deps.sourceRecords.getIncarnation(target.kind, target.collection_slug) };
    const expected = args.source_identity;
    if (!expected || expected.source_id !== sourceTarget.source_id || expected.received_at !== sourceTarget.received_at
      || expected.incarnation !== sourceTarget.incarnation) throw new RpcError('conflict', 'This source changed. Reopen the record before reading its links.');
  } else if (target.kind === 'contact') contactTarget = contactLinkedFromTarget(deps.contactDisplay, target.id, args.contact_identity);
  else {
    const entity = deps.resolver.readEntity(target.kind, target.id);
    if (!entity || entity._kind !== target.kind || entity.id !== target.id || entity.deleted_at != null
      || entity.sync_state === 'tombstoned' || entity.sync_state === 'orphaned') throw new RpcError('not_found', 'This record is no longer available.');
  }
  const targetIds = contactTarget?.reference_ids ?? [target.id];
  const matches = (link: Parameters<typeof savedWorkLinkMatches>[0]) => targetIds.some(id => savedWorkLinkMatches(link, { ...target, id }));
  const sources = deps.store.listSources(), excluded = readThroughSourceIds(sources);
  const rows = deps.store.listBodyLinkOwners({ target, target_ids: contactTarget ? targetIds : [savedWorkLinkIndexId(target)], limit: limit + 1, offset, excluded_source_ids: [...excluded] });
  const freshness = new Map(['task', 'note'].flatMap(kind => deps.resolver.sourceFreshness(kind as 'task' | 'note') ?? []).map(row => [row.source_id, row]));
  const items = rows.slice(0, limit).flatMap(row => {
    const owner = deps.store.readByKind(row.kind, row.id);
    if (!owner || owner._kind !== 'task' && owner._kind !== 'note') return [];
    const body = owner.body ?? '', link = savedWorkLinks(body).find(matches);
    if (!link) return [];
    const start = Math.max(0, link.start - 70), end = Math.min(body.length, start + 200);
    const state = freshness.get(owner.source_id);
    return [{ kind: row.kind, id: owner.id, title: (owner.title?.trim() || (row.kind === 'note' ? 'Note' : 'Task')).slice(0, 200),
      excerpt: `${start ? '…' : ''}${body.slice(start, end).replace(/\s+/gu, ' ').trim()}${end < body.length ? '…' : ''}`,
      source_id: owner.source_id, source_label: sources.find(source => source.id === owner.source_id)?.source_label ?? 'Source unavailable',
      created_at: owner.created_at, ...(owner.source_record_id !== undefined ? { source_record_id: owner.source_record_id } : {}),
      updated_at: owner.updated_at, stale: owner.sync_state === 'stale_unreachable' || state !== undefined && state.state !== 'local' && state.state !== 'fresh',
      ...(state?.list_complete === false ? { source_incomplete: true as const } : {}), pending_write: owner.pending_write !== undefined }];
  });
  const providerOnly = sources.filter(source => (source.top_tier_kind === 'task' || source.top_tier_kind === 'note') && excluded.has(source.id)).map(source => source.source_label);
  const calendar = target.kind === 'mail' ? deps.sourceRecords?.linkedCalendar?.(target, limit, calendarOffset) : undefined;
  return { ...(contactTarget ? { contact_target: contactTarget } : {}), ...(sourceTarget ? { source_target: sourceTarget } : {}), items, offset, more: rows.length > limit, ...(providerOnly.length ? { provider_only_sources: providerOnly } : {}),
    ...(calendar ? { calendar } : {}) };
};
