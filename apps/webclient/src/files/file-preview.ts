import { FILE_PREVIEW_MAX_BYTES, FILE_PREVIEW_TEXT_CHARACTERS,
  type FilePreviewRequest, type FilePreviewResult } from '@recued/contracts';
import { renderPdfPreview } from './file-preview-pdf.js';

export interface FilePreviewCallers {
  preview: (args: FilePreviewRequest) => Promise<FilePreviewResult>;
  read: (args: { record_id: string }) => Promise<{ record_id: string; filename: string; mime_type: string; bytes_b64: string }>;
}
export type FilePreviewTarget = FilePreviewRequest & { filename?: string };
const active = new WeakMap<Document, () => void>();

export const previewText = (bytes: Uint8Array): { text: string; truncated: boolean } => {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('This text encoding cannot be previewed. Download the file to open it.'); }
  if (text.includes('\0')) throw new Error('This file contains binary data. Download it to open it.');
  let visible = text.slice(0, FILE_PREVIEW_TEXT_CHARACTERS);
  if (/[\uD800-\uDBFF]$/.test(visible)) visible = visible.slice(0, -1);
  return { text: visible, truncated: visible.length < text.length };
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
  const decode = (value: string): Uint8Array => {
    const binary = doc.defaultView!.atob(value);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  };
  const urlFor = (bytes: Uint8Array, mime: string): string => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime })); urls.add(url); return url;
  };
  const load = async () => {
    const own = ++generation; release(); rendering = new AbortController();
    body.replaceChildren(); error.hidden = true; retry.hidden = true; download.disabled = true; status.textContent = 'Loading preview…';
    try {
      const file = await callers.preview({ record_id: target.record_id,
        ...(target.selection_revision ? { selection_revision: target.selection_revision } : {}) });
      if (!alive || own !== generation) return;
      if (file?.record_id !== target.record_id || typeof file.filename !== 'string' || typeof file.mime_type !== 'string') {
        throw new Error('File previews are unavailable on this server.');
      }
      title.textContent = file.filename;
      details.textContent = `${file.mime_type}${typeof file.size_bytes === 'number' ? ` · ${file.size_bytes.toLocaleString()} bytes` : ''}`;
      download.disabled = !file.can_download;
      if (!file.content) { status.textContent = file.unavailable_reason ?? 'No preview is available. You can download this file.'; return; }
      if (file.content.bytes_b64.length > Math.ceil(FILE_PREVIEW_MAX_BYTES / 3) * 4) throw new Error('This file is too large to preview.');
      const bytes = decode(file.content.bytes_b64);
      if (bytes.length > FILE_PREVIEW_MAX_BYTES || bytes.length !== file.size_bytes) throw new Error('The preview download was incomplete. Try again.');
      cached = { bytes, mime: file.mime_type, filename: file.filename };
      if (file.content.kind === 'text') {
        const text = previewText(bytes); const pre = doc.createElement('pre'); pre.textContent = text.text; pre.setAttribute('aria-label', 'File text');
        body.append(pre); status.textContent = text.truncated ? 'Showing the first 100,000 characters. Download the file to read the rest.' : '';
      } else if (file.content.kind === 'image') {
        const img = doc.createElement('img'); img.alt = file.filename; img.src = urlFor(bytes, file.mime_type); body.append(img);
        try { await img.decode(); } catch { throw new Error('This image could not be displayed. You can download it.'); }
        if (alive && own === generation) status.textContent = '';
      } else if (file.content.kind === 'pdf') {
        await renderPdfPreview(doc, body, bytes, rendering.signal, failure => { if (alive && own === generation) failed(failure); });
        if (alive && own === generation) status.textContent = '';
      } else throw new Error('This file format has no preview yet. You can download it.');
    } catch (failure) { if (alive && own === generation) failed(failure); }
  };
  download.addEventListener('click', () => {
    if (download.disabled) return; download.disabled = true;
    const own = generation;
    void (async () => {
      let content = cached;
      if (!content) {
        const file = await callers.read({ record_id: target.record_id });
        if (!alive || own !== generation) return;
        if (file.record_id !== target.record_id) throw new Error('The server returned a different file.');
        content = { bytes: decode(file.bytes_b64), mime: file.mime_type, filename: file.filename };
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
