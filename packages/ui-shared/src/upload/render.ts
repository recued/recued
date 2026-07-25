/** Shared resumable-upload widget — pure HTML renderers.
 *
 *  Two entry points, mirroring ref-picker:
 *   - `renderUploadWidget` paints the whole shell (drop-zone + file input +
 *     an empty progress region). The host embeds this string in the Data →
 *     File surface; `wire.ts` then ATTACHES to it.
 *   - `renderUploadProgress` paints ONLY the progress region body, so an
 *     engine tick repaints the bar without recreating the file input.
 *
 *  Filenames are user data — every interpolation flows through `e`.
 */

import { e } from '../template.js';
import type { UploadProgress, UploadWidgetConfig } from './types.js';

/** The shell marker — `wire.ts` finds its subtree by it. */
export const UPLOAD_SHELL_ATTR = 'data-upload';
/** Attribute names `wire.ts` and the renderers share. */
export const UPLOAD_INPUT_ATTR = 'data-upload-input';
export const UPLOAD_DROPZONE_ATTR = 'data-upload-dropzone';
export const UPLOAD_PROGRESS_ATTR = 'data-upload-progress';
export const UPLOAD_CANCEL_ATTR = 'data-upload-cancel';

const DEFAULT_PROMPT = 'Drop a file here, or click to choose';

/** Marker the shell carries. */
export const uploadShellAttr = (widgetId: string): string =>
  `${UPLOAD_SHELL_ATTR}="${e(widgetId)}"`;

const inputDomId = (widgetId: string): string => `upload-input-${widgetId}`;

/** The whole shell. The drop-zone is a `<label for>` wrapping the file input,
 *  so a click opens the native picker with zero JS; `wire.ts` adds drag/drop +
 *  progress repaints on top. */
export const renderUploadWidget = (config: UploadWidgetConfig): string => {
  const { widgetId } = config;
  const id = inputDomId(widgetId);
  const prompt = config.promptText ?? DEFAULT_PROMPT;
  return [
    `<div class="upload-widget" ${uploadShellAttr(widgetId)}>`,
    `<label class="upload-dropzone" ${UPLOAD_DROPZONE_ATTR} for="${e(id)}">`,
    `<span class="upload-dropzone-text">${e(prompt)}</span>`,
    `<input class="upload-input" ${UPLOAD_INPUT_ATTR} id="${e(id)}" type="file" />`,
    `</label>`,
    `<div class="upload-progress" ${UPLOAD_PROGRESS_ATTR} aria-live="polite">`,
    renderUploadProgress(null),
    `</div>`,
    `</div>`,
  ].join('');
};

const fmtMiB = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/** Just the progress-region body — the surgical-repaint unit. `wire.ts` sets
 *  `progressEl.innerHTML` to this on each engine tick, so the file input (and
 *  any in-progress native picker) is never recreated. `null` = idle (empty). */
export const renderUploadProgress = (progress: UploadProgress | null): string => {
  if (progress === null) return '';
  const name = e(progress.filename);
  if (progress.phase === 'done') {
    return [
      `<div class="upload-row upload-row--done">`,
      `<span class="upload-name">${name}</span>`,
      `<span class="upload-status">Uploaded ✓</span>`,
      `</div>`,
    ].join('');
  }
  if (progress.phase === 'error') {
    const detail = progress.error !== undefined ? `: ${e(progress.error)}` : '';
    return [
      `<div class="upload-row upload-row--error">`,
      `<span class="upload-name">${name}</span>`,
      `<span class="upload-status">Upload failed${detail}</span>`,
      `</div>`,
    ].join('');
  }
  const pct =
    progress.total > 0
      ? Math.min(100, Math.round((progress.sent / progress.total) * 100))
      : 0;
  const label =
    progress.phase === 'finalizing'
      ? 'Finalizing…'
      : `${pct}% · ${fmtMiB(progress.sent)}/${fmtMiB(progress.total)} MiB`;
  const cancel =
    progress.phase === 'uploading'
      ? `<button type="button" class="upload-cancel" ${UPLOAD_CANCEL_ATTR} aria-label="Cancel upload">Cancel</button>`
      : '';
  return [
    `<div class="upload-row">`,
    `<span class="upload-name">${name}</span>`,
    `<div class="upload-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">`,
    `<div class="upload-bar-fill" style="width:${pct}%"></div>`,
    `</div>`,
    `<span class="upload-status">${e(label)}</span>`,
    cancel,
    `</div>`,
  ].join('');
};
