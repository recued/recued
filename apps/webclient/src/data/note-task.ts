import { TASK_TITLE_MAX, type Note, type WorkEntity } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';
import { READER_PASSAGE_MAX } from './reader-passage.js';

const bounded = (text: string, limit: number): string => {
  let result = '';
  for (const character of text) { if (result.length + character.length > limit) break; result += character; }
  return result;
};
type NoteTaskEntity = Extract<WorkEntity, { _kind: 'task' | 'note' }>;
export const sameNoteTaskRecord = (original: NoteTaskEntity, current: WorkEntity | null): current is NoteTaskEntity =>
  (current?._kind === 'task' || current?._kind === 'note') && current._kind === original._kind
  && current.id === original.id && current.source_id === original.source_id && current.source_record_id === original.source_record_id
  && current.created_at === original.created_at;

/** A quotation of the saved note and its exact address. The task editor owns
 * destination, scheduling, relationships and the explicit save. */
export const noteTaskValues = (note: Note, clientUrl: string, selected?: string): Record<string, unknown> => {
  if (selected !== undefined && (!selected.trim() || selected.length > READER_PASSAGE_MAX)) throw new Error('Select a shorter passage before creating a task.');
  const url = new URL(clientUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The source note link is unavailable. Reopen the note before creating a task.');
  url.search = ''; url.username = ''; url.password = ''; url.hash = serializeShellRoute('data', 'note', note.id);
  const text = note.body.trim(), excerpt = bounded(text, 600);
  return { title: bounded(selected?.trim().split(/\r?\n/u)[0] || note.title?.trim() || 'Follow up on note', TASK_TITLE_MAX), done: false, due_at: null,
    body: [`Note: ${url.href}`,
      ...(note.pending_write || note.sync_state !== 'live' || note.deleted_at != null
        ? ['This excerpt is from a saved note whose source is unconfirmed. Open the note to check its current text.'] : []),
      '', ...(selected !== undefined ? ['Selected passage:', selected]
        : text ? [excerpt.length < text.length ? 'Note excerpt (partial):' : 'Note excerpt:', excerpt] : ['The note has no text. Open it for context.'])].join('\n') };
};
