import { chatSourceCitationsOf, type ChatMessage, type ChatSourceCitation } from '@recued/contracts';
import { serializeShellRoute, serializeSourceRecordAddress } from '../shell/route.js';

/** Addresses are built from typed server-kept locators, never model URLs. */
export const sourceCitationHref = (source: ChatSourceCitation, answer?: { sessionId: string; messageId: string }): string =>
  source.kind === 'file' ? serializeSourceRecordAddress({ tab: 'files', collectionSlug: source.collection_slug, recordId: source.file_ref,
      ...(answer ? { returnToChat: answer } : {}) })
    : source.kind === 'asset_projection' && source.projection.kind === 'context' && source.projection.root.kind === 'rule'
      ? serializeShellRoute('yours', 'asset', source.asset_id, 'view', 'rules') : serializeShellRoute('yours', 'asset', source.asset_id);

export const buildAnswerSources = (doc: Document, message: Pick<ChatMessage, 'id' | 'role' | 'source_citations'>, sessionId?: string,
  disclosure?: { open: boolean; changed(open: boolean): void }): HTMLElement | null => {
  const sources = message.role === 'assistant' ? chatSourceCitationsOf(message.source_citations) : [];
  if (!sources.length) return null;
  const root = doc.createElement('section'); root.className = 'chat-answer-sources';
  root.setAttribute('data-chat-answer-sources', ''); root.setAttribute('aria-label', 'Sources for this answer');
  const title = doc.createElement('strong'); title.textContent = 'Sources'; root.appendChild(title);
  const note = doc.createElement('p');
  note.textContent = sources.some(source => source.kind === 'asset_projection' && source.projection.kind === 'context')
    ? 'Sources cover only the returned facts or relationships. Links open the current source, which may have changed.'
    : sources.some(source => source.kind === 'asset_projection')
      ? 'Saved fact sources cover only the values returned. Links open the current source, which may have changed.'
      : 'Opens the current source. It may have changed since this answer.';
  root.appendChild(note);
  const list = doc.createElement('ul');
  const details = doc.createElement('details'); details.className = 'chat-source-details';
  if (disclosure?.open) details.open = true;
  details.addEventListener('toggle', () => { if (details.isConnected) disclosure?.changed(details.open); });
  const summary = doc.createElement('summary'); summary.textContent = 'Source details';
  summary.setAttribute('data-chat-source-details-toggle', ''); details.appendChild(summary);
  for (const source of sources) {
    const item = doc.createElement('li'); const link = doc.createElement('a');
    link.href = sourceCitationHref(source, sessionId ? { sessionId, messageId: message.id } : undefined);
    link.textContent = source.label; link.setAttribute('data-chat-answer-source', source.id);
    const kind = source.kind === 'asset' ? 'Saved asset' : source.kind === 'file' ? 'Document'
      : source.projection.kind === 'context' ? 'Relationships · Bounded view'
      : source.projection.kind === 'field' ? 'Saved fact' : 'Saved facts · Partial view';
    const time = doc.createElement('small'); time.textContent = ` · ${kind} · Read ${new Date(source.read_at).toLocaleString()}`;
    item.appendChild(link); list.appendChild(item);
    const provenance = doc.createElement('p'); provenance.appendChild(doc.createTextNode(source.label)); provenance.appendChild(time);
    details.appendChild(provenance);
  }
  root.appendChild(list); root.appendChild(details); return root;
};

export const ANSWER_SOURCES_STYLES = `
.chat-answer-sources { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); font-size: .875rem; }
.chat-answer-sources p { margin: 4px 0 8px; color: var(--muted); }
.chat-answer-sources ul { margin: 0; padding: 0; list-style: none; }
.chat-answer-sources li { margin: 5px 0; overflow-wrap: anywhere; }
.chat-answer-sources a { display: inline-block; padding: 4px 0; }
.chat-answer-sources small { color: var(--muted); }
.chat-source-details { margin-top: 6px; }
.chat-source-details summary { cursor: pointer; min-height: 32px; align-content: center; color: var(--muted); }
@media (pointer: coarse) { .chat-answer-sources a { min-height: 44px; box-sizing: border-box; padding: 12px 0; } }
@media (pointer: coarse) { .chat-source-details summary { min-height: 44px; } }
`;
