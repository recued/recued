import type { FileLifecyclePreview } from '@recued/contracts';
import { serializeChatAnswerAddress, serializeChatSessionAddress } from '../shell/route.js';

export interface FileLifecyclePanelState {
  fileId: string;
  preview?: FileLifecyclePreview;
  busy: boolean;
  error?: string;
  confirmDelete?: boolean;
}
const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const renderFileLifecyclePanel = (state: FileLifecyclePanelState, actionAttr: string): string => {
  const p = state.preview;
  const disabled = state.busy ? ' disabled aria-busy="true"' : '';
  const button = (action: string, label: string, unavailable = false): string =>
    `<button type="button" class="data-button" ${actionAttr}="${action}"${disabled}${unavailable && !state.busy ? ' disabled' : ''}>${label}</button>`;
  return `<section data-file-lifecycle role="region" aria-label="File usage and deletion" tabindex="-1">
    ${state.error ? `<p role="alert">${escape(state.error)}</p>` : ''}
    ${!p ? `<p>${state.busy ? 'Checking where this file is used…' : 'Recued cannot tell where this file is used.'}</p>${button('file-usage', 'Retry')}` : `
      <p>${p.message_count} ${p.message_count === 1 ? 'message' : 'messages'} in ${p.conversation_count} ${p.conversation_count === 1 ? 'conversation' : 'conversations'} · ${p.queued_count} queued · ${p.delivery_count} pending deliveries</p>
      ${p.usages.length ? `<ul>${p.usages.map(u => `<li><a href="${escape(u.message_id
        ? serializeChatAnswerAddress({ sessionId: u.session_id, messageId: u.message_id })
        : serializeChatSessionAddress({ sessionId: u.session_id }))}">${u.message_id ? 'Open message' : 'Open conversation'}</a>${u.turn_id ? ` · ${escape(u.state)}` : ''}</li>`).join('')}</ul>` : ''}
      ${p.usages_truncated ? '<p>Showing the first 100 uses. The counts and deletion include every use.</p>' : ''}
      ${p.in_use ? '<p role="status">File currently in use. Permanent deletion is available after the active operation finishes.</p>' : ''}
      ${p.deleted ? '<p>File deleted for good. The messages about it are still there.</p>' : state.confirmDelete ? `
        <p>Permanently delete this file and its retained attachment versions? Conversations will show “File deleted”. Queued messages needing it will fail. Copies already sent to Messenger remain there.</p>
        ${button('file-delete-confirm', 'Yes, delete it for good', p.in_use)} ${button('file-delete-cancel', 'Keep file')}` : `
        <p>Archive moves the file to archived files and keeps its attachments available. Permanent deletion removes those attachments too.</p>
        ${!p.archived ? button('file-archive', 'Archive') : '<p>Archived from the file library.</p>'}
        ${button('file-delete', 'Permanently delete', p.in_use)}`}
      ${button('file-usage', 'Check again')}`}
  </section>`;
};
