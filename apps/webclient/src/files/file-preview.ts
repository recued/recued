import { FILE_PREVIEW_MAX_BYTES, FILE_PREVIEW_TEXT_CHARACTERS, filePreviewKind,
  FILE_READ_CHUNK_MAX_BYTES, type FileContentReadRequest, type FileContentReadResponse,
  type FilePreviewRequest, type FilePreviewResult, type FilePreviewConversionRequest, type FilePreviewConversionResult } from '@recued/contracts';
import { renderPdfPreview } from './file-preview-pdf.js';
import { renderDocxPreview } from './file-preview-docx.js';
import { renderActionIcon } from '@recued/ui-shared';
import { isCsvPreview, mountCsvPreview } from './csv-preview.js';
import { mountPreviewConversion } from './file-preview-conversion.js';

export interface FilePreviewCallers {
  preview: (args: FilePreviewRequest) => Promise<FilePreviewResult>;
  convert?: (args: FilePreviewConversionRequest) => Promise<FilePreviewConversionResult>;
  read: (args: FileContentReadRequest) => Promise<Pick<FileContentReadResponse, 'record_id' | 'filename' | 'mime_type' | 'bytes_b64'> & Partial<FileContentReadResponse>>;
}
export type FilePreviewTarget = FilePreviewRequest & { filename?: string };
/** Fetch bounded RPC chunks, pin their source version, then verify the complete
 * file. A cancelled or inconsistent transfer never reaches the browser save. */
export const readStoredFileDownload = async (
  target: FilePreviewTarget & { content_hash?: string; size?: number },
  callers: Pick<FilePreviewCallers, 'read'>, signal?: AbortSignal,
): Promise<{ filename: string; mime_type: string; bytes: Uint8Array } | undefined> => {
  const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const chunks: Uint8Array[] = [];
  let offset = 0, expected = target.content_hash, size = target.size, filename: string | undefined, mime: string | undefined;
  while (true) {
    if (signal?.aborted) return;
    const file = await callers.read({ record_id: target.record_id, offset, length: FILE_READ_CHUNK_MAX_BYTES,
      ...(expected ? { expected_hash: expected } : {}) });
    if (signal?.aborted) return;
    if (file.record_id !== target.record_id) throw new Error('The server returned a different file.');
    if ((filename !== undefined && file.filename !== filename) || (mime !== undefined && file.mime_type !== mime)) throw new Error('The file changed during download.');
    filename = file.filename; mime = file.mime_type;
    const bytes = Uint8Array.from(atob(file.bytes_b64), char => char.charCodeAt(0));
    // Older paired servers return the whole file. Never accept this after a chunk.
    if (file.offset === undefined) {
      if (offset !== 0) throw new Error('The download lost its chunk position.');
      expected ??= file.content_hash || file.blob_hash || undefined;
      size ??= file.size_bytes; chunks.push(bytes); offset = bytes.length; break;
    }
    if (file.offset !== offset || bytes.length > FILE_READ_CHUNK_MAX_BYTES
      || !Number.isSafeInteger(file.size_bytes) || Number(file.size_bytes) < 0
      || (size !== undefined && size !== file.size_bytes)
      || typeof file.content_hash !== 'string' || !/^[a-f0-9]{64}$/.test(file.content_hash)
      || (expected !== undefined && expected !== file.content_hash)
      || await digest(bytes) !== file.chunk_hash) throw new Error('The downloaded chunk does not match this file.');
    size = file.size_bytes; expected = file.content_hash; chunks.push(bytes); offset += bytes.length;
    if (offset > size!) throw new Error('The download exceeds the file size.');
    if (file.next_offset === null) {
      if (offset !== size) throw new Error('The file download was incomplete. Try again.');
      break;
    }
    if (!bytes.length || file.next_offset !== offset || offset >= size!) throw new Error('The download did not advance correctly.');
  }
  if (size !== undefined && offset !== size) throw new Error('The file download was incomplete. Try again.');
  const bytes = new Uint8Array(offset); let written = 0;
  for (const chunk of chunks) { bytes.set(chunk, written); written += chunk.length; }
  if (expected && await digest(bytes) !== expected) throw new Error('The downloaded file does not match this attachment.');
  if (signal?.aborted) return;
  return { filename: filename!, mime_type: mime!, bytes };
};
export const downloadStoredFile = async (
  doc: Document, target: FilePreviewTarget & { content_hash?: string; size?: number },
  callers: Pick<FilePreviewCallers, 'read'>, signal?: AbortSignal,
): Promise<void> => {
  const file = await readStoredFileDownload(target, callers, signal);
  if (!file || signal?.aborted) return;
  const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.mime_type }));
  try { const link = doc.createElement('a'); link.href = url; link.download = file.filename; link.click(); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
};
const active = new WeakMap<Document, () => void>();

const decodePreviewText = (bytes: Uint8Array): string => {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('This text encoding cannot be previewed. Download the file to open it.'); }
  if (text.includes('\0')) throw new Error('This file contains binary data. Download it to open it.');
  return text;
};
const limitPreviewText = (text: string): { text: string; truncated: boolean } => {
  let visible = text.slice(0, FILE_PREVIEW_TEXT_CHARACTERS);
  if (/[\uD800-\uDBFF]$/.test(visible)) visible = visible.slice(0, -1);
  return { text: visible, truncated: visible.length < text.length };
};
export const previewText = (bytes: Uint8Array): { text: string; truncated: boolean } => limitPreviewText(decodePreviewText(bytes));

/** D-274 — the DECODE-AND-DRAW half of the viewer, split out so a surface that
 *  is not a modal can draw the same thing. `openFilePreview` is now the dialog
 *  shell around this; the recipes result panel mounts it inline.
 *
 *  ⛔ SPLIT RATHER THAN COPIED, deliberately. The size cap, the
 *  `bytes.length !== size_bytes` integrity check, the object-URL lifetime and
 *  the text/image/pdf branching are the parts that are easy to get subtly wrong
 *  and hard to notice — a second implementation would drift from this one and
 *  the drift would show up as "the inline preview shows something different
 *  from the popup", which nobody reports as a bug.
 *
 *  The caller owns everything stateful: the container, the object-URL set (via
 *  `urlFor`), the status line, and the generation guard. This function owns
 *  only the fetch, the checks and the drawing, and hands back the metadata the
 *  caller needs for its own chrome plus the bytes it may want to cache. */
export interface FilePreviewBodyHost {
  doc: Document;
  /** Where the drawn element goes. Cleared by the CALLER before each attempt. */
  body: HTMLElement;
  /** Object-URL factory owned by the caller, so revocation stays with the
   *  lifetime that created it. */
  urlFor: (bytes: Uint8Array, mime: string) => string;
  /** Status line updates. A no-op is fine for a surface without one. */
  status: (text: string) => void;
  signal: AbortSignal;
  /** False once the caller has moved on — a late async draw must not land. */
  isCurrent: () => boolean;
  /** Async failures raised AFTER this resolves (the pdf renderer does this). */
  onFailure: (failure: unknown) => void;
  /** The file's details, as soon as they are known and BEFORE anything is
   *  drawn. A draw can throw (a broken PDF, an image that will not decode,
   *  binary text), and the result carries the same details only on success.
   *  So chrome that must not depend on the draw, like the dialog's Download
   *  button, reads them here. An unreadable file is exactly the one a person
   *  needs to download. */
  onMeta?: (meta: FilePreviewBodyResult) => void;
  /** Verified original bytes, before a renderer that may fail. */
  onBytes?: (meta: FilePreviewBodyResult) => void;
  offerConversion?: (meta: FilePreviewBodyResult) => void;
}

export interface FilePreviewBodyResult extends Pick<FilePreviewResult, 'origin' | 'export_as' | 'created_at' | 'modified_at' | 'content_hash' | 'download_unavailable_reason' | 'selection_revision' | 'conversion'> {
  filename: string;
  mime_type: string;
  size_bytes?: number;
  can_download: boolean;
  /** Present only when bytes were decoded — absent when the server returned no
   *  previewable content. */
  bytes?: Uint8Array;
}

const filePreviewMetadata = (target: FilePreviewTarget, file: FilePreviewResult): FilePreviewBodyResult => {
  if (file?.record_id !== target.record_id || typeof file.filename !== 'string' || typeof file.mime_type !== 'string') {
    throw new Error('File previews are unavailable on this server.');
  }
  return {
    filename: file.filename, mime_type: file.mime_type,
    ...(typeof file.size_bytes === 'number' ? { size_bytes: file.size_bytes } : {}),
    can_download: file.can_download === true,
    ...(file.selection_revision ? { selection_revision: file.selection_revision } : {}),
    ...(file.conversion ? { conversion: file.conversion } : {}),
    ...(file.origin ? { origin: file.origin } : {}),
    ...(file.export_as ? { export_as: file.export_as } : {}),
    ...(file.created_at !== undefined ? { created_at: file.created_at } : {}),
    ...(file.modified_at !== undefined ? { modified_at: file.modified_at } : {}),
    ...(file.content_hash ? { content_hash: file.content_hash } : {}),
    ...(file.download_unavailable_reason ? { download_unavailable_reason: file.download_unavailable_reason } : {}),
  };
};

export const renderFilePreviewBody = async (
  host: FilePreviewBodyHost,
  target: FilePreviewTarget,
  callers: FilePreviewCallers,
): Promise<FilePreviewBodyResult> => {
  const { doc, body } = host;
  const file = await callers.preview({ record_id: target.record_id,
    ...(target.selection_revision ? { selection_revision: target.selection_revision } : {}) });
  const meta = filePreviewMetadata(target, file);
  if (!host.isCurrent()) return meta;
  host.onMeta?.(meta);
  if (!file.content) {
    host.status(file.unavailable_reason ?? 'No preview is available. You can download this file.');
    if (host.offerConversion) host.offerConversion(meta);
    else if (meta.conversion && meta.selection_revision && callers.convert) mountPreviewConversion({ doc, container: body, body,
      target: { record_id: target.record_id, selection_revision: meta.selection_revision }, availability: meta.conversion,
      convert: callers.convert, preview: callers.preview, signal: host.signal, isCurrent: host.isCurrent });
    return meta;
  }
  if (file.content.bytes_b64.length > Math.ceil(FILE_PREVIEW_MAX_BYTES / 3) * 4) throw new Error('This file is too large to preview.');
  const binary = doc.defaultView!.atob(file.content.bytes_b64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length > FILE_PREVIEW_MAX_BYTES || bytes.length !== file.size_bytes) throw new Error('The preview download was incomplete. Try again.');
  meta.bytes = bytes;
  host.onBytes?.(meta);
  if (file.content.kind === 'text') {
    const decoded = decodePreviewText(bytes), text = limitPreviewText(decoded);
    if (isCsvPreview(file.filename, file.mime_type)) mountCsvPreview({ doc, body, filename: file.filename, mime_type: file.mime_type, text: decoded, raw: text,
      signal: host.signal, isCurrent: () => host.isCurrent(), status: text => host.status(text) });
    else {
      const pre = doc.createElement('pre'); pre.textContent = text.text; pre.setAttribute('aria-label', 'File text'); body.append(pre);
      host.status(text.truncated ? 'Showing the first 100,000 characters. Download the file to read the rest.' : '');
    }
  } else if (file.content.kind === 'image') {
    const img = doc.createElement('img'); img.alt = file.filename; img.src = host.urlFor(bytes, file.mime_type); body.append(img);
    try { await img.decode(); } catch { throw new Error('This image could not be displayed. You can download it.'); }
    if (host.isCurrent()) host.status('');
  } else if (file.content.kind === 'pdf') {
    await renderPdfPreview(doc, body, bytes, host.signal, failure => { if (host.isCurrent()) host.onFailure(failure); });
    if (host.isCurrent()) host.status('');
  } else if (file.content.kind === 'docx') {
    host.status('Reading document…');
    const truncated = await renderDocxPreview(doc, body, bytes, host.signal);
    if (host.isCurrent()) host.status(truncated
      ? 'Document text · Showing the first 100,000 characters. Download the file to read the rest.'
      : 'Document text · Simplified preview. Download for the complete document.');
  } else throw new Error('This file format has no preview yet. You can download it.');
  return meta;
};

/** One shared, temporary viewer. It never attaches, imports, or sends a file.
 * The caller's lifetime retires late reads; closing frees URLs and PDF workers. */
export const openFilePreview = (
  doc: Document, target: FilePreviewTarget, callers: FilePreviewCallers, signal?: AbortSignal,
): Promise<void> => {
  active.get(doc)?.();
  const before = doc.activeElement as HTMLElement | null;
  const dialog = doc.createElement('dialog'); dialog.setAttribute('data-file-preview', '');
  dialog.setAttribute('aria-label', 'File preview');
  const style = doc.createElement('style');
  style.textContent = `dialog[data-file-preview] { width:min(1100px,calc(100vw - 48px)); max-width:none;
    height:min(800px,calc(100dvh - 48px)); max-height:none; box-sizing:border-box; padding:0;
    border:1px solid var(--border,#666); border-radius:14px; background:var(--surface,#fff); color:var(--fg,#222); font:14px/1.5 system-ui,sans-serif; }
    dialog[data-file-preview][open] { display:flex; flex-direction:column; }
    dialog[data-file-preview]::backdrop { background:#0008; }
    [data-file-preview] [hidden] { display:none !important; }
    [data-file-preview] h2 { margin:0; font-size:1.1rem; overflow-wrap:anywhere;
      display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
    [data-file-preview] h3 { margin:16px 0; font-size:1.1rem; }
    [data-file-preview] p { margin:8px 0; overflow-wrap:anywhere; }
    [data-file-preview] button { padding:8px 12px; font:inherit; border:1px solid var(--border,#888); border-radius:7px;
      background:var(--surface,#fff); color:var(--fg,#222); cursor:pointer; }
    [data-file-preview] button:disabled { opacity:.55; cursor:default; }
    [data-file-preview] .file-preview-actions svg { width:18px; height:18px; vertical-align:middle; }
    [data-file-preview] button:focus-visible { outline:2px solid var(--accent,#467ee9); outline-offset:2px; }
    [data-file-preview] .file-preview-header { display:flex; gap:16px; align-items:center; padding:16px 20px; border-bottom:1px solid var(--border,#ddd); }
    [data-file-preview] .file-preview-heading { flex:1; min-width:0; }
    [data-file-preview] .file-preview-meta { color:var(--fg-muted,#666); font-size:.85rem; margin:4px 0 0; }
    [data-file-preview] .file-preview-actions { position:relative; display:flex; gap:8px; flex-shrink:0; }
    [data-file-preview] .file-preview-menu { position:absolute; z-index:2; right:0; top:calc(100% + 8px); width:210px; padding:6px;
      background:var(--surface,#fff); border:1px solid var(--border,#aaa); border-radius:10px; box-shadow:0 8px 28px #0003; }
    [data-file-preview] .file-preview-menu button { display:block; text-align:left; width:100%; border-color:transparent; }
    [data-file-preview] .file-preview-menu button:hover { background:var(--surface-sunk,#eee); }
    [data-file-preview] .file-preview-content { flex:1; min-height:0; overflow:auto; padding:16px 20px;
      display:grid; grid-template-columns:minmax(0,1fr); align-items:start; }
    [data-file-preview] .file-preview-content > section { grid-area:1/1; min-width:0; }
    [data-file-preview] .file-preview-pane[aria-hidden=true] { visibility:hidden; height:0; overflow:hidden; pointer-events:none; }
    [data-file-preview] [role=alert] { color:var(--danger,#b91c1c); }
    [data-file-preview] .file-preview-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:10px 0; }
    [data-file-preview] .file-preview-footer { display:flex; align-items:center; gap:12px; padding:10px 20px; border-top:1px solid var(--border,#ddd); }
    [data-file-preview] .file-preview-footer p { flex:1; font-size:.85rem; color:var(--fg-muted,#666); }
    [data-file-preview] .file-preview-info { width:100%; max-width:760px; margin:0 auto; }
    [data-file-preview] dl { display:grid; grid-template-columns:minmax(100px,150px) minmax(0,1fr); gap:12px 20px; }
    [data-file-preview] dt { color:var(--fg-muted,#666); } [data-file-preview] dd { margin:0; overflow-wrap:anywhere; white-space:pre-wrap; }
    [data-file-preview-body] { min-height:64px; }
    [data-file-preview-body] img { display:block; max-width:100%; max-height:65vh; object-fit:contain; margin:auto; }
    [data-file-preview-body] pre { white-space:pre-wrap; overflow-wrap:anywhere; tab-size:4; font:13px/1.5 ui-monospace,monospace; }
    [data-file-preview] .file-preview-pdf-page { overflow:auto; background:#ddd; }
    [data-file-preview] canvas { display:block; margin:auto; }
    @media(max-width:600px) { dialog[data-file-preview] { width:100vw; height:100dvh; margin:0; border:0; border-radius:0; }
      [data-file-preview] .file-preview-header { padding:12px; gap:8px; align-items:flex-start; }
      [data-file-preview] .file-preview-content { padding:12px; }
      [data-file-preview] .file-preview-footer { padding:8px 12px; }
      [data-file-preview] .file-preview-download-label { display:none; }
      [data-file-preview] .file-preview-header button { min-width:40px; min-height:40px; padding:8px; }
      [data-file-preview] dl { grid-template-columns:1fr; gap:4px; } [data-file-preview] dd { margin-bottom:12px; } }`;
  const header = doc.createElement('header'); header.className = 'file-preview-header';
  const heading = doc.createElement('div'); heading.className = 'file-preview-heading';
  const title = doc.createElement('h2'); title.textContent = target.filename ?? 'File preview';
  title.title = title.textContent;
  const details = doc.createElement('p'); details.className = 'file-preview-meta'; details.textContent = 'Loading file information…';
  heading.append(title, details);
  const actions = doc.createElement('div'); actions.className = 'file-preview-actions';
  const makeButton = (label: string) => { const button = doc.createElement('button'); button.type = 'button'; button.textContent = label; return button; };
  const download = makeButton(''); download.setAttribute('aria-label', 'Download file'); download.title = 'Download file';
  const icon = (name: 'download' | 'more' | 'close') => { const span = doc.createElement('span'); span.setAttribute('aria-hidden', 'true'); span.innerHTML = renderActionIcon(name); return span; };
  const downloadIcon = icon('download');
  const downloadLabel = doc.createElement('span'); downloadLabel.className = 'file-preview-download-label'; downloadLabel.textContent = ' Download file';
  download.append(downloadIcon, downloadLabel);
  const more = makeButton(''); more.append(icon('more')); more.setAttribute('aria-label', 'File actions'); more.setAttribute('aria-expanded', 'false'); more.title = 'File actions';
  const menu = doc.createElement('div'); menu.className = 'file-preview-menu'; menu.hidden = true; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', 'File actions');
  menu.id = 'file-preview-actions'; more.setAttribute('aria-controls', menu.id);
  const menuDownload = makeButton('Download file');
  const showDetails = makeButton('File details'); const showOrigin = makeButton('Origin');
  menu.append(menuDownload, showDetails, showOrigin);
  const done = makeButton(''); done.append(icon('close')); done.setAttribute('aria-label', 'Close preview'); done.title = 'Close preview';
  actions.append(download, more, menu, done); header.append(heading, actions);
  const content = doc.createElement('div'); content.className = 'file-preview-content';
  const previewPane = doc.createElement('section'); previewPane.className = 'file-preview-pane';
  const status = doc.createElement('p'); status.setAttribute('role', 'status');
  const error = doc.createElement('p'); error.setAttribute('role', 'alert'); error.hidden = true;
  const body = doc.createElement('section'); body.setAttribute('data-file-preview-body', '');
  previewPane.append(status, error, body);
  const info = doc.createElement('section'); info.className = 'file-preview-info'; info.hidden = true;
  const back = makeButton('← Back to preview'); const infoTitle = doc.createElement('h3');
  const infoBody = doc.createElement('div'); info.append(back, infoTitle, infoBody); content.append(previewPane, info);
  const footer = doc.createElement('footer'); footer.className = 'file-preview-footer';
  const note = doc.createElement('p');
  note.textContent = target.record_id.startsWith('file:remote:') ? 'Temporary preview. The file stays in your connected source.'
    : target.record_id.startsWith('file:local:') ? 'Read from its watched folder.' : 'Preview of this saved file.';
  const retry = makeButton('Retry preview'); retry.hidden = true;
  footer.append(note, retry);
  const downloadStatus = doc.createElement('p'); downloadStatus.setAttribute('role', 'status'); downloadStatus.hidden = true;
  downloadStatus.setAttribute('aria-label', 'Download status');
  downloadStatus.style.padding = '0 20px';
  dialog.append(style, header, content, downloadStatus, footer);
  let known: FilePreviewBodyResult | undefined;
  let infoView: 'details' | 'origin' | undefined;
  let informationFailed = false, downloadBusy = false, previewScroll = 0;
  let infoGeneration = -1;
  const closeMenu = () => { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); };
  const updateDownload = () => {
    const label = known?.export_as ? 'Download exported file' : 'Download file';
    downloadLabel.textContent = ` ${label}`; download.setAttribute('aria-label', label); download.title = known?.download_unavailable_reason ?? label;
    menuDownload.textContent = label; menuDownload.title = download.title;
    download.disabled = menuDownload.disabled = downloadBusy || known?.can_download === false;
  };
  const fillInfo = () => {
    infoBody.replaceChildren();
    const paragraph = (text: string) => { const p = doc.createElement('p'); p.textContent = text; infoBody.append(p); };
    const rows = doc.createElement('dl');
    const row = (label: string, value: string | undefined) => {
      if (!value) return; const term = doc.createElement('dt'), definition = doc.createElement('dd'); term.textContent = label; definition.textContent = value; rows.append(term, definition);
    };
    const date = (value: number | undefined) => {
      const date = typeof value === 'number' ? new Date(value) : undefined;
      return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : undefined;
    };
    if (infoView === 'details') {
      infoTitle.textContent = 'File details'; row('Name', known?.filename ?? target.filename);
      row('Type', known?.mime_type); row('Size', known?.size_bytes !== undefined ? `${known.size_bytes.toLocaleString()} bytes` : undefined);
      row('Added', date(known?.created_at)); row('Modified', date(known?.modified_at));
      row('SHA-256', known?.content_hash);
      if (known?.export_as) paragraph('The connected source provides an export of this file. Download saves the exported representation shown here.');
    } else {
      infoTitle.textContent = 'Origin';
      if (known?.origin) {
        row('Source', known.origin.label); row('Source name', known.origin.source_filename); row('Path', known.origin.path);
        row('Saved on', date(known.origin.captured_at));
        if (known.origin.saved_copy) paragraph('This is a saved copy. Later changes or disconnection at the source do not update this file.');
      } else if (known) paragraph('Origin not recorded.');
    }
    if (!known) paragraph(informationFailed ? 'File information could not be loaded. Retry the preview to try again.' : 'Loading file information…');
    if (known?.download_unavailable_reason) paragraph(known.download_unavailable_reason);
    infoBody.append(rows);
  };
  const setMetadata = (knownMeta: FilePreviewBodyResult) => {
    known = knownMeta;
    title.textContent = title.title = knownMeta.filename;
    const kind = filePreviewKind(knownMeta.mime_type);
    const format = isCsvPreview(knownMeta.filename, knownMeta.mime_type) ? 'CSV'
      : kind === 'docx' ? 'Word document' : kind === 'pdf' ? 'PDF document'
        : kind === 'image' ? 'Image' : kind === 'text' ? 'Text document' : 'File';
    const size = knownMeta.size_bytes;
    const readableSize = typeof size !== 'number' ? '' : size < 1024 ? `${size.toLocaleString()} bytes`
      : `${(size / (size < 1024 * 1024 ? 1024 : 1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${size < 1024 * 1024 ? 'KiB' : 'MiB'}`;
    details.textContent = `${format}${readableSize ? ` · ${readableSize}` : ''}`;
    updateDownload(); fillInfo();
  };
  const openInfo = (view: 'details' | 'origin') => {
    if (!infoView) previewScroll = content.scrollTop;
    infoView = view; fillInfo(); previewPane.setAttribute('aria-hidden', 'true'); previewPane.inert = true;
    info.hidden = false; closeMenu(); content.scrollTop = 0; back.focus();
    // File information remains usable when the preview's content read fails.
    if (!known && infoGeneration !== generation) {
      const own = generation; infoGeneration = own; informationFailed = false; fillInfo();
      void Promise.resolve().then(() => {
        if (!alive || own !== generation) return;
        return callers.preview({ record_id: target.record_id, ...(target.selection_revision ? { selection_revision: target.selection_revision } : {}), metadata_only: true });
      })
        .then(file => { if (file && alive && own === generation && !known) setMetadata(filePreviewMetadata(target, file)); })
        .catch(() => { if (alive && own === generation && !known) { informationFailed = true; fillInfo(); } });
    }
  };
  more.addEventListener('click', () => { menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) (menuDownload.disabled ? showDetails : menuDownload).focus(); });
  showDetails.addEventListener('click', () => openInfo('details')); showOrigin.addEventListener('click', () => openInfo('origin'));
  back.addEventListener('click', () => { infoView = undefined; info.hidden = true; previewPane.removeAttribute('aria-hidden'); previewPane.inert = false; content.scrollTop = previewScroll; more.focus(); });
  dialog.addEventListener('click', event => { if (!actions.contains(event.target as Node)) closeMenu(); });
  let alive = true; let generation = 0; let rendering = new AbortController();
  let cached: { bytes: Uint8Array; mime: string; filename: string } | undefined;
  const urls = new Set<string>();
  let resolve!: () => void;
  const result = new Promise<void>(finish => { resolve = finish; });
  const release = () => { rendering.abort(); for (const url of urls) URL.revokeObjectURL(url); urls.clear(); cached = undefined; };
  const close = (restoreFocus = true) => {
    if (!alive) return; alive = false; generation++; release(); signal?.removeEventListener('abort', abort);
    dialog.remove(); if (active.get(doc) === retire) active.delete(doc);
    if (restoreFocus && before?.isConnected) before.focus({ preventScroll: true });
    resolve();
  };
  const retire = () => close(false);
  const abort = () => close(false);
  const failed = (failure: unknown) => {
    if (!alive) return;
    error.textContent = failure instanceof Error && failure.name === 'PasswordException'
      ? 'This PDF needs a password. Download it to open it.'
      : failure instanceof Error ? failure.message : 'Could not preview this file.';
    error.hidden = false; status.textContent = ''; retry.hidden = false;
    informationFailed = !known; fillInfo(); updateDownload();
    if (known) offerConversion(known);
  };
  const urlFor = (bytes: Uint8Array, mime: string): string => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime })); urls.add(url); return url;
  };
  const offerConversion = (meta: FilePreviewBodyResult) => {
    if (!meta.conversion || !meta.selection_revision || !callers.convert || !alive
      || previewPane.querySelector('[data-file-preview-conversion]')) return;
    const own = generation;
    mountPreviewConversion({ doc, container: previewPane, body,
      target: { record_id: target.record_id, selection_revision: meta.selection_revision }, availability: meta.conversion,
      onSourceHash: hash => {
        if (!alive || own !== generation || !known) return;
        if (known.content_hash !== hash) cached = undefined;
        known.content_hash = hash; fillInfo(); status.textContent = ''; error.hidden = true; retry.hidden = true;
      },
      convert: callers.convert, preview: callers.preview, signal: rendering.signal, isCurrent: () => alive && own === generation });
  };
  const load = async () => {
    const own = ++generation; release(); rendering = new AbortController();
    previewPane.querySelector('[data-file-preview-conversion]')?.remove();
    body.replaceChildren(); error.hidden = true; retry.hidden = true; known = undefined; informationFailed = false;
    downloadBusy = false; downloadStatus.hidden = true; updateDownload(); fillInfo(); status.textContent = 'Loading preview…';
    try {
      // D-274 — the dialog is now CHROME around the shared body renderer. Every
      // check that used to live here (size cap, integrity, kind branching) is in
      // `renderFilePreviewBody`, so the inline surface cannot drift from this one.
      const meta = await renderFilePreviewBody({
        doc, body, urlFor, signal: rendering.signal,
        status: text => { if (alive && own === generation) status.textContent = text; },
        isCurrent: () => alive && own === generation,
        onFailure: failed,
        offerConversion,
        onBytes: meta => { if (alive && own === generation && meta.bytes) cached = { bytes: meta.bytes, mime: meta.mime_type, filename: meta.filename }; },
        // ⛔ BEFORE the draw, not after it. Set after, a draw that throws left
        // Download disabled on exactly the file that could not be shown, and
        // the one a person most needs to save (D-274 regressed this).
        onMeta: (knownMeta) => {
          if (!alive || own !== generation) return;
          setMetadata(knownMeta);
        },
      }, target, callers);
      if (!alive || own !== generation) return;
      if (meta.bytes) cached = { bytes: meta.bytes, mime: meta.mime_type, filename: meta.filename };
    } catch (failure) { if (alive && own === generation) failed(failure); }
  };
  const save = () => {
    if (download.disabled) return; downloadBusy = true; updateDownload(); closeMenu();
    downloadStatus.setAttribute('role', 'status'); downloadStatus.textContent = 'Preparing download…'; downloadStatus.hidden = false;
    const own = generation, downloadSignal = rendering.signal;
    void (async () => {
      let content = cached;
      if (!content) {
        let identity = known;
        const expectedHash = identity?.content_hash;
        // A failed preview must not turn a stale picker selection into a
        // download of its replacement. Recheck metadata without decoding it.
        if (target.selection_revision) {
          const checked = await callers.preview({ record_id: target.record_id, selection_revision: target.selection_revision, metadata_only: true });
          if (!alive || own !== generation) return;
          identity = filePreviewMetadata(target, checked);
          if (!known) { known = identity; updateDownload(); fillInfo(); }
          if (!identity.can_download) {
            known = identity; updateDownload(); fillInfo();
            throw new Error(identity.download_unavailable_reason ?? checked.unavailable_reason ?? 'This file cannot be downloaded.');
          }
        }
        const hash = expectedHash ?? identity?.content_hash;
        const file = await readStoredFileDownload({ ...target, ...(hash ? { content_hash: hash } : {}) }, callers, downloadSignal);
        if (!file) return;
        if (!alive || own !== generation) return;
        if (identity && (file.filename !== identity.filename || file.mime_type !== identity.mime_type
          || (identity.size_bytes !== undefined && file.bytes.length !== identity.size_bytes))) {
          throw new Error('This file changed. Close the preview and select it again.');
        }
        content = { bytes: file.bytes, mime: file.mime_type, filename: file.filename };
      }
      const url = urlFor(content.bytes, content.mime); const link = doc.createElement('a'); link.href = url; link.download = content.filename; link.click();
      downloadStatus.textContent = 'Download started.';
      setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
    })().catch(failure => { if (alive && own === generation) {
      downloadStatus.setAttribute('role', 'alert'); downloadStatus.textContent = failure instanceof Error ? failure.message : 'Could not download this file. Try again.';
    } })
      .finally(() => { if (alive && own === generation) { downloadBusy = false; updateDownload(); } });
  };
  download.addEventListener('click', save); menuDownload.addEventListener('click', save);
  done.addEventListener('click', () => close()); retry.addEventListener('click', () => { void load(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation();
    if (!menu.hidden) { closeMenu(); more.focus(); } else close(); } });
  if (signal?.aborted) { close(false); return result; }
  signal?.addEventListener('abort', abort, { once: true }); active.set(doc, retire);
  doc.body.append(dialog); dialog.showModal(); done.focus(); void load();
  return result;
};
