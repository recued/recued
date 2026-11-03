import type { MailMessageAttachment, MailMessageAttachmentsRequest, MailMessageAttachmentsSnapshot, MailMessageRef } from '@recued/contracts';
import { e, renderActionLabel } from '@recued/ui-shared';
import { downloadStoredFile, openFilePreview, type FilePreviewCallers } from '../files/file-preview.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export type MailAttachmentsCaller = (input: MailMessageAttachmentsRequest) => Promise<MailMessageAttachmentsSnapshot>;
const valid = (value: MailMessageAttachmentsSnapshot, input: MailMessageAttachmentsRequest): boolean => {
  const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  return Boolean(value && value.slug === input.slug && value.record_id === input.record_id
    && typeof value.incarnation === 'string' && value.incarnation.length > 0
    && (!input.expected_incarnation || input.expected_incarnation === value.incarnation)
    && (!input.conversation || input.conversation.incarnation === value.incarnation)
    && typeof value.truncated === 'boolean' && Array.isArray(value.warnings) && value.warnings.every(warning => typeof warning === 'string')
    && Array.isArray(value.items) && value.items.length <= 100 && new Set(value.items.map(item => item?.file_id)).size === value.items.length
    && value.items.every(item => item && /^file:[a-f0-9]{32}$/.test(item.file_id)
      && typeof item.filename === 'string' && typeof item.mime_type === 'string'
      && (item.size === null || Number.isSafeInteger(item.size) && item.size >= 0)
      && (item.unavailable_reason === undefined
        || typeof item.unavailable_reason === 'string' && item.unavailable_reason.trim().length > 0)
      && (item.unavailable_reason !== undefined || item.size !== null && hash(item.content_hash) && hash(item.selection_revision))));
};
const bytes = (size: number | null): string => size === null ? 'Size unavailable'
  : size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
const typeLabel = (mime: string): string => {
  const type = mime.split(';')[0]!.trim().toLowerCase();
  switch (type) {
    case 'application/pdf': return 'PDF';
    case 'application/msword':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'Word document';
    case 'application/vnd.ms-excel':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'Excel workbook';
    case 'application/vnd.ms-powerpoint':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': return 'PowerPoint presentation';
    case 'text/csv': case 'application/csv': return 'CSV table';
    case 'application/zip': return 'ZIP archive';
    default: return type.startsWith('image/') ? 'Image' : type.startsWith('audio/') ? 'Audio'
      : type.startsWith('video/') ? 'Video' : type.startsWith('text/') ? 'Text file' : 'File';
  }
};

/** Retained attachments are independent of body/reply reads and never own a draft. */
export const createMailAttachmentsSurface = (deps: {
  document: Document; get?: MailAttachmentsCaller; files?: FilePreviewCallers; actionAttr: string; render(): void;
}) => {
  let ref: MailMessageRef | null = null, key = '', generation = 0, requestGeneration = 0;
  let snapshot: MailMessageAttachmentsSnapshot | null = null, incarnation: string | null = null;
  let loading = false, hint = false, error = '', unsupported = false, disposed = false, busy: string | null = null;
  let filePhase: 'checking' | 'reading' | null = null, operation: 'preview' | 'download' | null = null;
  let abort: AbortController | null = null;
  const paint = () => { if (!disposed) deps.render(); };
  const retireView = () => { abort?.abort(); abort = null; busy = null; filePhase = null; operation = null; };
  const request = (): MailMessageAttachmentsRequest => ({ ...ref!,
    ...(incarnation ? { expected_incarnation: incarnation } : {}) });
  const read = async () => {
    if (!ref || !deps.get || disposed) return;
    // A newer list read owns the details. An older pending open cannot replace
    // them; an already opened viewer keeps its reviewed, retained copy.
    if (filePhase === 'checking') retireView();
    const own = generation, seq = ++requestGeneration, input = request();
    loading = true; error = ''; paint();
    try {
      const value = await deps.get(input);
      if (disposed || own !== generation || seq !== requestGeneration) return;
      if (!valid(value, input)) throw new Error('The saved attachments could not be confirmed. Refresh attachments.');
      snapshot = value; incarnation = value.incarnation; unsupported = false;
    } catch (cause) {
      if (disposed || own !== generation || seq !== requestGeneration) return;
      unsupported = ['unknown_method', 'method_not_found'].includes(classifyRpcError(cause).code ?? '');
      error = unsupported ? '' : humanizeRpcError(cause);
      if (classifyRpcError(cause).code === 'resource_changed') retireView();
      snapshot = null;
    } finally { if (!disposed && own === generation && seq === requestGeneration) { loading = false; paint(); } }
  };
  const openFile = async (id: string, download: boolean) => {
    const selected = snapshot?.items.find(item => item.file_id === id);
    if (!ref || !snapshot || !deps.get || !deps.files || !selected || selected.unavailable_reason || busy || loading) return;
    const own = generation, input = request(), expected = snapshot.incarnation;
    const controller = new AbortController(); abort = controller; busy = id;
    filePhase = 'checking'; operation = download ? 'download' : 'preview'; error = ''; paint();
    const current = () => !disposed && own === generation && !controller.signal.aborted && abort === controller;
    try {
      // Recheck the exact message/link and enrollment before a file read. A
      // renamed/replaced copy needs another owner selection.
      const fresh = await deps.get({ ...input, expected_incarnation: expected });
      if (!current()) return;
      if (!valid(fresh, input)) throw new Error('The saved attachments could not be confirmed. Refresh attachments.');
      snapshot = fresh;
      const item = fresh.items.find(value => value.file_id === id);
      if (!item || item.unavailable_reason || item.selection_revision !== selected.selection_revision || item.content_hash !== selected.content_hash) {
        throw new Error(item?.unavailable_reason || 'This attachment changed. Review its current details and choose it again.');
      }
      filePhase = 'reading'; paint();
      const callers: FilePreviewCallers = {
        ...(deps.files!.convert ? { convert: async (args) => {
          if (!current()) throw new Error('The email selection changed.');
          const value = await deps.files!.convert!(args);
          if (!current()) throw new Error('The email selection changed.');
          return value;
        } } : {}),
        preview: async args => {
          if (!current()) throw new Error('The email selection changed.');
          const value = await deps.files!.preview(args);
          if (!current()) throw new Error('The email selection changed.');
          return value;
        },
        read: async args => {
          if (!current()) throw new Error('The email selection changed.');
          const value = await deps.files!.read(args);
          if (!current()) throw new Error('The email selection changed.');
          return value;
        },
      };
      if (download) await downloadStoredFile(deps.document, { record_id: id, content_hash: item.content_hash!, size: item.size! }, callers, controller.signal);
      else await openFilePreview(deps.document, { record_id: id, filename: item.filename, selection_revision: item.selection_revision }, callers, controller.signal);
    } catch (cause) { if (current()) { error = humanizeRpcError(cause); if (classifyRpcError(cause).code === 'resource_changed') snapshot = null; } }
    finally {
      if (current()) {
        abort = null; busy = null; filePhase = null; operation = null; paint();
        deps.document.querySelector<HTMLElement>(`[data-mail-focus="attachment-${download ? 'download' : 'preview'}:${id}"]`)?.focus({ preventScroll: true });
      }
    }
  };
  const reset = () => { generation++; requestGeneration++; retireView(); ref = null; key = ''; snapshot = null; incarnation = null; error = ''; hint = false; loading = false; unsupported = false; };
  return {
    open(next: MailMessageRef, hasAttachments: boolean): void {
      if (disposed) return;
      const nextKey = JSON.stringify(next);
      if (key !== nextKey) { reset(); key = nextKey; ref = { ...next }; }
      hint = hasAttachments; unsupported = !deps.get;
      if (deps.get) void read();
    },
    reset,
    dispose(): void { reset(); disposed = true; },
    closePreview: retireView,
    render(): string {
      if (!ref || !snapshot?.items.length && !snapshot?.warnings.length && !snapshot?.truncated && !error && (!loading || !hint) && (!unsupported || !hint)) return '';
      const disabled = loading || busy !== null;
      const button = (name: string, label: string, icon: 'asset' | 'download', item: MailMessageAttachment) =>
        `<button type="button" class="data-button" ${deps.actionAttr}="mail-message-attachment-${name}" data-mail-file="${e(item.file_id)}" data-mail-focus="attachment-${name}:${e(item.file_id)}"${disabled ? ' aria-disabled="true"' : ''}>${renderActionLabel(icon, label)}</button>`;
      return `<section class="data-mail-attachments" aria-label="Email attachments"><div class="data-mail-attachments-heading"><h3>Attachments${snapshot?.items.length ? ` <span>${snapshot.items.length}</span>` : ''}</h3>
        ${deps.get ? `<button type="button" class="data-button" ${deps.actionAttr}="mail-message-attachments-refresh" data-mail-focus="attachments-refresh"${disabled ? ' aria-disabled="true"' : ''}>${renderActionLabel('refresh', error ? 'Retry attachments' : 'Refresh attachments')}</button>` : ''}</div>
        ${loading ? '<p role="status">Checking saved attachments…</p>' : ''}${error ? `<p role="status">${e(error)}</p>` : ''}
        ${busy ? `<p role="status">${filePhase === 'checking' ? 'Checking attachment…' : operation === 'download' ? 'Downloading attachment…' : 'Opening attachment…'}</p>` : ''}
        ${unsupported ? '<p>Update your Recued server to open saved attachments here.</p>' : ''}
        ${snapshot?.items.length ? `<ul>${snapshot.items.map(item => `<li><div><strong>${e(item.filename)}</strong><p>${e(bytes(item.size))} · ${e(typeLabel(item.mime_type))}</p>${item.unavailable_reason ? `<p>${e(item.unavailable_reason)}</p>` : ''}</div>
          ${!item.unavailable_reason && deps.files ? `<div class="data-mail-attachment-actions">${button('preview', 'Open', 'asset', item)}${button('download', 'Download', 'download', item)}</div>` : !item.unavailable_reason ? '<p>File viewing is unavailable here.</p>' : ''}</li>`).join('')}</ul>` : ''}
        ${snapshot?.warnings.map(warning => `<p>${e(warning)}</p>`).join('') ?? ''}${snapshot?.truncated ? '<p>More saved attachments may exist. This list is incomplete.</p>' : ''}
        ${snapshot?.items.length ? '<p class="data-mail-attachments-note">Saved copies on this server. Inline images may also appear here.</p>' : ''}
      </section>`;
    },
    handleAction(name: string, target?: HTMLElement): boolean {
      if (name === 'mail-message-attachments-refresh') { if (!loading && !busy) void read(); return true; }
      if (name !== 'mail-message-attachment-preview' && name !== 'mail-message-attachment-download') return false;
      const id = target?.getAttribute('data-mail-file');
      if (id) void openFile(id, name.endsWith('-download'));
      return true;
    },
  };
};

export const MAIL_ATTACHMENTS_STYLES = `
.data-mail-attachments { display:grid; gap:12px; min-width:0; padding-top:16px; border-top:1px solid var(--border); }
.data-mail-attachments-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; }
.data-mail-attachments h3, .data-mail-attachments p { margin:0; }
.data-mail-attachments h3 { font-size:14px; }.data-mail-attachments h3 span { color:var(--fg-muted); font-weight:400; }
.data-mail-attachments p { color:var(--fg-muted); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
.data-mail-attachments ul { display:grid; gap:8px; list-style:none; padding:0; margin:0; }
.data-mail-attachments li { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px 16px; border:1px solid var(--border); border-radius:8px; padding:12px; min-width:0; }
.data-mail-attachments li > div:first-child { min-width:0; flex:1 1 180px; overflow-wrap:anywhere; }
.data-mail-attachments strong { display:block; margin-bottom:4px; font-size:14px; }
.data-mail-attachment-actions { display:flex; flex-wrap:wrap; gap:8px; }
.data-mail-attachments .data-button { appearance:none; display:inline-flex; align-items:center; gap:6px; background:var(--surface,transparent); color:var(--fg); }
.data-mail-attachments-note { font-size:12px; }
`;
