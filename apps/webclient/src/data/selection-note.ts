import { NOTE_TITLE_MAX, type Note } from '@recued/contracts';
import { draftOriginHash, type DraftOrigin } from './draft-origin.js';
import { READER_PASSAGE_MAX } from './reader-passage.js';

export const selectionNoteValues = (text: string, origin: DraftOrigin, clientHref: string, existing?: Note) => {
  if (!text.trim() || text.length > READER_PASSAGE_MAX || origin.kind !== 'mail' && origin.kind !== 'note') throw new Error('Select a shorter passage in Mail or Notes.');
  const url = new URL(clientHref);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The source link is unavailable. Reopen the reader.');
  url.username = ''; url.password = ''; url.search = ''; url.hash = draftOriginHash(origin);
  const quote = `Selected passage from ${origin.kind === 'mail' ? 'email' : 'note'}: <${url.href}>\n\n`
    + text.replace(/\r\n?/gu, '\n').split('\n').map(line => '> ' + line).join('\n');
  const body = existing ? existing.body + (existing.body.length === 0 ? '' : existing.body.endsWith('\n\n') ? '' : existing.body.endsWith('\n') ? '\n' : '\n\n') + quote : quote;
  if (body.length > 100_000) throw new Error('This passage would make the note too long. Choose another note or create a new one.');
  let title = '';
  for (const character of text.trim().split(/\r?\n/u)[0] || origin.label) {
    if (title.length + character.length > NOTE_TITLE_MAX) break;
    title += character;
  }
  return { ...(existing ? {} : { title }), body };
};
