import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import type { FilePreviewConversionAvailability, FilePreviewConversionRequest, FilePreviewConversionResult,
  FilePreviewConverter, FilePreviewRequest, FilePreviewResult } from '@recued/contracts';

export interface PreviewConversionHost {
  doc: Document;
  container: HTMLElement;
  body: HTMLElement;
  target: FilePreviewRequest;
  availability: FilePreviewConversionAvailability;
  convert(args: FilePreviewConversionRequest): Promise<FilePreviewConversionResult>;
  preview(args: FilePreviewRequest): Promise<FilePreviewResult>;
  signal: AbortSignal;
  isCurrent(): boolean;
  onSourceHash?(hash: string): void;
}
const readerName = (reader: FilePreviewConverter): string => reader === 'docling' ? 'Docling' : 'MarkItDown';

/** A click starts conversion; neither mounting nor checking readers reads file
 * bytes. Closing the viewer retires polling and any late response. */
export const mountPreviewConversion = (host: PreviewConversionHost): void => {
  const { doc, container } = host;
  container.querySelector('[data-file-preview-conversion]')?.remove();
  const panel = doc.createElement('section'); panel.setAttribute('data-file-preview-conversion', '');
  panel.setAttribute('aria-label', 'Convert for preview');
  panel.style.cssText = 'border:1px solid var(--border,#ddd);border-radius:10px;padding:16px;margin:12px 0;';
  const heading = doc.createElement('h3'); heading.textContent = 'Text preview'; heading.style.marginTop = '0';
  const explanation = doc.createElement('p');
  explanation.textContent = 'A document reader can convert this file to text. Conversion may need your approval. Images, layout and some content may be omitted.';
  const remote = doc.createElement('p'); remote.textContent = host.target.record_id.startsWith('file:remote:')
    ? 'Recued downloads a temporary copy for the reader. The original stays at its source.'
    : 'The reader uses a temporary copy. The original file stays unchanged.';
  const controls = doc.createElement('div'); controls.className = 'file-preview-controls';
  controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;align-items:center;';
  const label = doc.createElement('label'); label.textContent = 'Reader ';
  const reader = doc.createElement('select'); reader.setAttribute('aria-label', 'Document reader');
  reader.style.cssText = 'font:inherit;padding:8px;border-radius:7px;max-width:100%;background:var(--surface,#fff);color:inherit;border:1px solid var(--border,#888);';
  label.append(reader);
  const action = doc.createElement('button'); action.type = 'button'; action.textContent = 'Convert for preview';
  const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Check readers';
  const packs = doc.createElement('a'); packs.href = '#packs'; packs.target = '_blank'; packs.rel = 'noopener'; packs.textContent = 'Browse reader packs (new tab)';
  const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-label', 'Conversion status');
  const approvals = doc.createElement('a'); approvals.href = '#approvals'; approvals.target = '_blank'; approvals.rel = 'noopener';
  approvals.textContent = 'Review approval (new tab)'; approvals.hidden = true;
  const activity = doc.createElement('p'); activity.hidden = true;
  const activityLink = doc.createElement('a'); activityLink.href = '#logs'; activityLink.target = '_blank'; activityLink.rel = 'noopener';
  activityLink.textContent = 'View Activity (new tab)';
  activity.append('Conversion continues if you close this preview. ', activityLink);
  controls.append(label, action, packs, refresh);
  panel.append(heading, explanation, remote, controls, status, approvals, activity);
  if (host.body.parentElement === container) container.insertBefore(panel, host.body);
  else container.append(panel);
  let availability = host.availability;
  let busy = false, requestId: string | undefined, conversion: FilePreviewConversionResult | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renderedText: HTMLPreElement | undefined;
  const current = () => !host.signal.aborted && host.isCurrent() && panel.isConnected;
  const updateReaders = () => {
    const previous = reader.value;
    reader.replaceChildren();
    for (const value of availability.readers) {
      const option = doc.createElement('option'); option.value = value; option.textContent = readerName(value); reader.append(option);
    }
    if (availability.readers.some(value => value === previous)) reader.value = previous;
    const missing = !availability.readers.length;
    label.hidden = action.hidden = missing; packs.hidden = refresh.hidden = !missing;
    if (missing) status.textContent = availability.unavailable_reason ?? 'Add MarkItDown or Docling from Packs, then check readers again.';
  };
  const display = (result: FilePreviewConversionResult) => {
    if (!current()) return;
    if (result.record_id !== host.target.record_id || result.selection_revision !== host.target.selection_revision
      || (conversion && result.conversion_id !== conversion.conversion_id)) throw new Error('The server returned a different conversion. Close the preview and select the file again.');
    if (result.state === 'ready' && (typeof result.text !== 'string' || result.text.length > 100_000
      || !/^[a-f0-9]{64}$/u.test(result.source_content_hash ?? ''))) throw new Error('The server returned an invalid text preview. Download the original file to open it.');
    conversion = result;
    if (result.state === 'ready') {
      host.onSourceHash?.(result.source_content_hash!);
      explanation.textContent = `Converted with ${readerName(result.converter)}.`;
      const pre = doc.createElement('pre'); pre.textContent = result.text ?? ''; pre.setAttribute('aria-label', 'Converted document text');
      renderedText = pre;
      pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;font:13px/1.5 ui-monospace,monospace;';
      host.body.replaceChildren(...(panel.parentElement === host.body ? [panel, pre] : [pre]));
      status.textContent = `${result.message}${result.truncated ? ' Showing the first 100,000 characters. Download the original file to read the rest.' : ''}`;
      action.textContent = 'Convert again'; approvals.hidden = true;
    } else {
      status.textContent = result.message;
      approvals.hidden = result.state !== 'awaiting_approval';
      action.textContent = result.state === 'failed' ? 'Retry conversion'
        : result.state === 'awaiting_approval' ? 'Awaiting approval' : 'Converting…';
    }
    status.setAttribute('role', result.state === 'failed' ? 'alert' : 'status');
    busy = result.state === 'running' || result.state === 'awaiting_approval';
    activity.hidden = !busy;
    action.disabled = reader.disabled = busy;
    if (busy) timer = setTimeout(() => { void check(); }, 1500);
  };
  const failure = (cause: unknown) => {
    if (!current()) return;
    if (['not_found', 'expired'].includes(classifyRpcError(cause).code ?? '')) { conversion = undefined; requestId = undefined; }
    busy = false; action.disabled = false;
    reader.disabled = (requestId !== undefined && conversion === undefined)
      || (conversion !== undefined && ['running', 'awaiting_approval'].includes(conversion.state));
    action.textContent = conversion && ['running', 'awaiting_approval'].includes(conversion.state) ? 'Check conversion' : 'Try conversion again';
    status.setAttribute('role', 'alert');
    status.textContent = humanizeRpcError(cause) || 'The conversion could not be checked. Try again, or download the original file.';
  };
  const check = async () => {
    if (!current() || !conversion) return;
    try { display(await host.convert({ action: 'status', conversion_id: conversion.conversion_id })); }
    catch (cause) { failure(cause); }
  };
  action.addEventListener('click', () => {
    if (busy || !current()) return;
    if (conversion && ['running', 'awaiting_approval'].includes(conversion.state)) { busy = true; action.disabled = reader.disabled = true; void check(); return; }
    if (conversion) { requestId = undefined; conversion = undefined; }
    renderedText?.remove(); renderedText = undefined;
    explanation.textContent = 'A document reader can convert this file to text. Conversion may need your approval. Images, layout and some content may be omitted.';
    requestId ??= crypto.randomUUID();
    busy = true; action.disabled = reader.disabled = true; action.textContent = 'Preparing conversion…';
    activity.hidden = false;
    status.setAttribute('role', 'status'); status.textContent = 'Preparing the reader. Any required approval appears in Approvals.';
    const request = { action: 'start' as const, record_id: host.target.record_id, selection_revision: host.target.selection_revision!,
      request_id: requestId, converter: reader.value as FilePreviewConverter };
    void Promise.resolve().then(() => host.convert(request))
      .then(display).catch(failure);
  });
  refresh.addEventListener('click', () => {
    if (refresh.disabled || !current()) return;
    refresh.disabled = true; status.setAttribute('role', 'status'); status.textContent = 'Checking document readers…';
    void Promise.resolve().then(() => host.preview({ ...host.target, metadata_only: true })).then(file => {
      if (!current()) return;
      if (file.record_id !== host.target.record_id || file.selection_revision !== host.target.selection_revision) throw new Error('This file changed. Close the preview and select it again.');
      availability = file.conversion ?? { readers: [], unavailable_reason: 'Conversion is unavailable for this file.' }; updateReaders();
      if (availability.readers.length) status.textContent = 'A document reader is available. Choose Convert for preview to continue.';
    }).catch(failure).finally(() => { if (current()) refresh.disabled = false; });
  });
  host.signal.addEventListener('abort', () => { if (timer !== undefined) clearTimeout(timer); }, { once: true });
  updateReaders();
};
