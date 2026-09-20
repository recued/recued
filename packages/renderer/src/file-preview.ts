/** D-274 — the non-browser rendering of a `file_preview` block.
 *
 *  ⛔ THIS SURFACE CANNOT DRAW THE FILE, and that is not a gap to close here.
 *  Drawing means decoding bytes, minting an object URL and awaiting
 *  `img.decode()` — a live `Document`. This renderer emits HTML STRINGS for
 *  channels that have none (the bridge mirror, reception pages, a server-side
 *  render). So it draws a CARD about the file, the same shape `file_artifact`
 *  already uses, and the browser surface draws the picture.
 *
 *  ⚠ The asymmetry is the point rather than an oversight: `file_preview` is a
 *  REQUEST to draw inline, and a surface that cannot honour it says what the
 *  file is instead of failing. Before this existed the block fell through to
 *  `renderBlockError('unsupported section type')` — which is a lie, because the
 *  type is supported, just not drawable here.
 */

import { renderBlockEmpty, renderBlockError } from './block-error.js';
import { renderBlockLabel } from './label.js';
import { e } from './escape.js';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const displayBytes = (value: unknown): string =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? `${value.toLocaleString('en-US')} bytes`
    : 'Unknown size';

export const renderFilePreviewBlock = (
  data: unknown,
  label?: string,
): string => {
  const record = asRecord(data);
  if (record === null) {
    return data === null || data === undefined
      ? renderBlockEmpty('file preview')
      : renderBlockError('file_preview', 'expected one file descriptor');
  }
  // D-274 — either shape identifies a file; neither is drawable here. The inline
  // one carries BYTES, which this surface must not echo into HTML: a base64
  // payload in a server-rendered page is weight nobody asked for and a data:
  // URL a non-browser channel cannot use anyway.
  const recordId = nonEmptyString(record.record_id);
  const hasInline = typeof record.bytes_b64 === 'string' && record.bytes_b64.length > 0;
  if (recordId === null && !hasInline) {
    return renderBlockError('file_preview', 'the file descriptor carries no file');
  }
  const filename = nonEmptyString(record.filename) ?? 'Unnamed file';
  const mime = nonEmptyString(record.mime_type) ?? 'Unknown type';
  return `${renderBlockLabel(label)}<article class="recued-file-preview">
  <p class="recued-file-preview-name">${e(filename)}</p>
  <dl class="recued-file-preview-meta">
    <div><dt>Type</dt><dd>${e(mime)}</dd></div>
    <div><dt>Size</dt><dd>${e(displayBytes(record.size_bytes))}</dd></div>
  </dl>
  <p class="recued-file-preview-note">This view cannot show the file itself. Open it in Recued to see it.</p>
</article>`;
};
