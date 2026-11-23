import type { SourceRegistration, WorkEntity } from '@recued/contracts';

export type DuplicateKind = 'task' | 'note';
export type DuplicateEntity = Extract<WorkEntity, { _kind: DuplicateKind }>;
export const isDuplicateEntity = (entity: WorkEntity | null): entity is DuplicateEntity => Boolean(entity
  && (entity._kind === 'task' || entity._kind === 'note') && entity.sync_state === 'live' && entity.deleted_at == null && !entity.pending_write);
export const sameDuplicateEntity = (original: DuplicateEntity, fresh: WorkEntity | null): fresh is DuplicateEntity => isDuplicateEntity(fresh)
  && fresh._kind === original._kind && fresh.id === original.id && fresh.source_id === original.source_id
  && fresh.source_record_id === original.source_record_id && fresh.created_at === original.created_at;
export const duplicateDestinations = (sources: readonly SourceRegistration[], kind: DuplicateKind): SourceRegistration[] =>
  sources.filter(source => source.top_tier_kind === kind && source.write_capable && source.sync_posture !== 'read_through');

/** Form values only: identity, native record ids, timestamps, provenance,
 * extension fields, completion and the previous deadline never seed a create. */
export const duplicateWorkValues = (entity: DuplicateEntity): Record<string, unknown> => {
  if (entity._kind === 'note') return { title: entity.title ?? '', body: entity.body,
    related_contact: [...entity.related_contact_ids], related_calendar_event: [...entity.related_calendar_event_ids],
    related_mail_thread: [...entity.related_mail_thread_ids], related_project: [...entity.related_project_ids] };
  return { title: entity.title, body: entity.body ?? '', done: false, due_at: null,
    priority: entity.priority ?? '', assigned_contact: entity.assigned_contact_id ?? '',
    parent_calendar_event: entity.parent_calendar_event_id ?? '', linked_mail_thread: entity.linked_mail_thread_id ?? '',
    parent_project: entity.parent_project_id ?? '', blocks_task: [...entity.blocks_task_ids] };
};
