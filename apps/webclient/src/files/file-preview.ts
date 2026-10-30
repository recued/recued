import { FILE_PREVIEW_MAX_BYTES, FILE_PREVIEW_TEXT_CHARACTERS,
  FILE_READ_CHUNK_MAX_BYTES, type FileContentReadRequest, type FileContentReadResponse,
  type FilePreviewRequest, type FilePreviewResult } from '@recued/contracts';
import { renderPdfPreview } from './file-preview-pdf.js';
import { isCsvPreview, mountCsvPreview } from './csv-preview.js';

export interface FilePreviewCallers {
  preview: (args: FilePreviewRequest) => Promise<FilePreviewResult>;
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
}

export interface FilePreviewBodyResult {
  filename: string;
  mime_type: string;
  size_bytes?: number;
  can_download: boolean;
  /** Present only when bytes were decoded — absent when the server returned no
   *  previewable content. */
  bytes?: Uint8Array;
}

export const renderFilePreviewBody = async (
  host: FilePreviewBodyHost,
  target: FilePreviewTarget,
  callers: FilePreviewCallers,
): Promise<FilePreviewBodyResult> => {
  const { doc, body } = host;
  const file = await callers.preview({ record_id: target.record_id,
    ...(target.selection_revision ? { selection_revision: target.selection_revision } : {}) });
  if (file?.record_id !== target.record_id || typeof file.filename !== 'string' || typeof file.mime_type !== 'string') {
    throw new Error('File previews are unavailable on this server.');
  }
  const meta: FilePreviewBodyResult = {
    filename: file.filename, mime_type: file.mime_type,
    ...(typeof file.size_bytes === 'number' ? { size_bytes: file.size_bytes } : {}),
    can_download: file.can_download === true,
  };
  if (!host.isCurrent()) return meta;
  host.onMeta?.(meta);
  if (!file.content) {
    host.status(file.unavailable_reason ?? 'No preview is available. You can download this file.');
    return meta;
  }
  if (file.content.bytes_b64.length > Math.ceil(FILE_PREVIEW_MAX_BYTES / 3) * 4) throw new Error('This file is too large to preview.');
  const binary = doc.defaultView!.atob(file.content.bytes_b64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length > FILE_PREVIEW_MAX_BYTES || bytes.length !== file.size_bytes) throw new Error('The preview download was incomplete. Try again.');
  meta.bytes = bytes;
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
  style.textContent = `dialog[data-file-preview] { width:min(960px,96vw); max-width:96vw; max-height:92vh; box-sizing:border-box;
    padding:18px; border:1px solid var(--border,#666); border-radius:12px; background:var(--surface,#fff); color:var(--fg,#222); font:14px/1.45 system-ui,sans-serif; }
    dialog[data-file-preview]::backdrop { background:#0008; }
    [data-file-preview] [hidden] { display:none !important; }
    [data-file-preview] h2 { margin:0 0 8px; font-size:1.2rem; overflow-wrap:anywhere; }
    [data-file-preview] p { margin:8px 0; overflow-wrap:anywhere; }
    [data-file-preview] button { padding:8px 12px; font:inherit; border:1px solid var(--border,#888); border-radius:6px;
      background:var(--surface,#fff); color:var(--fg,#222); cursor:pointer; }
    [data-file-preview] button:disabled { opacity:.55; cursor:default; }
    [data-file-preview] .file-preview-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:10px 0; }
    [data-file-preview-body] { max-height:62vh; overflow:auto; min-height:64px; }
    [data-file-preview-body] img { display:block; max-width:100%; max-height:60vh; object-fit:contain; margin:auto; }
    [data-file-preview-body] pre { white-space:pre-wrap; overflow-wrap:anywhere; tab-size:4; font:13px/1.5 ui-monospace,monospace; }
    [data-file-preview] .file-preview-pdf-page { overflow:auto; background:#ddd; }
    [data-file-preview] canvas { display:block; margin:auto; }`;
  const title = doc.createElement('h2'); title.textContent = target.filename ?? 'File preview';
  const details = doc.createElement('p');
  const note = doc.createElement('p');
  note.textContent = target.record_id.startsWith('file:remote:')
    ? 'Temporary preview from your connected source. Import saves a separate copy of the download at that time.'
    : target.record_id.startsWith('file:local:')
      ? 'Preview of this file, read from its folder on your server.'
      : 'Preview of this saved file.';
  const status = doc.createElement('p'); status.setAttribute('role', 'status');
  const error = doc.createElement('p'); error.setAttribute('role', 'alert'); error.hidden = true;
  const body = doc.createElement('section'); body.setAttribute('data-file-preview-body', '');
  const footer = doc.createElement('div'); footer.className = 'file-preview-controls';
  const download = doc.createElement('button'); download.type = 'button'; download.textContent = 'Download file'; download.disabled = true;
  const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry preview'; retry.hidden = true;
  const done = doc.createElement('button'); done.type = 'button'; done.textContent = 'Close preview';
  footer.append(download, retry, done); dialog.append(style, title, details, note, status, error, body, footer);
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
  };
  const urlFor = (bytes: Uint8Array, mime: string): string => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime })); urls.add(url); return url;
  };
  const load = async () => {
    const own = ++generation; release(); rendering = new AbortController();
    body.replaceChildren(); error.hidden = true; retry.hidden = true; download.disabled = true; status.textContent = 'Loading preview…';
    try {
      // D-274 — the dialog is now CHROME around the shared body renderer. Every
      // check that used to live here (size cap, integrity, kind branching) is in
      // `renderFilePreviewBody`, so the inline surface cannot drift from this one.
      const meta = await renderFilePreviewBody({
        doc, body, urlFor, signal: rendering.signal,
        status: text => { if (alive && own === generation) status.textContent = text; },
        isCurrent: () => alive && own === generation,
        onFailure: failed,
        // ⛔ BEFORE the draw, not after it. Set after, a draw that throws left
        // Download disabled on exactly the file that could not be shown, and
        // the one a person most needs to save (D-274 regressed this).
        onMeta: (known) => {
          if (!alive || own !== generation) return;
          title.textContent = known.filename;
          const format = isCsvPreview(known.filename, known.mime_type) ? 'CSV' : known.mime_type;
          details.textContent = `${format}${typeof known.size_bytes === 'number' ? ` · ${known.size_bytes.toLocaleString()} bytes` : ''}`;
          download.disabled = !known.can_download;
        },
      }, target, callers);
      if (!alive || own !== generation) return;
      if (meta.bytes) cached = { bytes: meta.bytes, mime: meta.mime_type, filename: meta.filename };
    } catch (failure) { if (alive && own === generation) failed(failure); }
  };
  download.addEventListener('click', () => {
    if (download.disabled) return; download.disabled = true;
    const own = generation;
    void (async () => {
      let content = cached;
      if (!content) {
        const file = await readStoredFileDownload(target, callers, rendering.signal);
        if (!file) return;
        if (!alive || own !== generation) return;
        content = { bytes: file.bytes, mime: file.mime_type, filename: file.filename };
      }
      const url = urlFor(content.bytes, content.mime); const link = doc.createElement('a'); link.href = url; link.download = content.filename; link.click();
      setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
    })().catch(failure => { if (alive && own === generation) failed(failure); })
      .finally(() => { if (alive && own === generation) download.disabled = false; });
  });
  done.addEventListener('click', () => close()); retry.addEventListener('click', () => { void load(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
  if (signal?.aborted) { close(false); return result; }
  signal?.addEventListener('abort', abort, { once: true }); active.set(doc, retire);
  doc.body.append(dialog); dialog.showModal(); done.focus(); void load();
  return result;
};
