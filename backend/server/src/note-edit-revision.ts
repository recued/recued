import { createHash } from 'node:crypto';
import { canonicalJSONStringify, type Note } from '@recued/contracts';

/** A content/identity revision, independent of read-access timestamps. Same-ms
 * edits and a replacement row must invalidate an earlier editing snapshot. */
export const noteEditRevision = (note: Note): string => createHash('sha256').update(canonicalJSONStringify([
  note.id, note.source_id, note.source_record_id ?? null, note.connection_id ?? null, note.created_at, note.updated_at,
  note.title ?? null, note.body, [...note.related_contact_ids].sort(), [...note.related_calendar_event_ids].sort(),
  [...note.related_mail_thread_ids].sort(), [...note.related_project_ids].sort(), note.source_extension_blob ?? null,
  note.sync_state, note.deleted_at ?? null, note.pending_write ?? null, note.source_record_hash ?? null,
  note.source_version_token ?? null, note.source_updated_at ?? null,
])).digest('hex');

export class NoteEditConflictError extends Error {
  constructor() { super('This note changed while you were editing. Your draft is still here. Reopen the latest note before saving your passage.'); this.name = 'NoteEditConflictError'; }
}
