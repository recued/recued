import { isFileCloudCapture } from '@recued/contracts';

const escape = (value: string): string => value.replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Shared by Files and Conversation files. All source text is display-only;
 * neither a remote ID nor a provider-supplied path becomes a download URL. */
export const renderFileCloudCapture = (value: unknown): string => {
  if (!isFileCloudCapture(value)) return '';
  const field = (label: string, text: string): string =>
    `<div><dt>${escape(label)}</dt><dd>${escape(text)}</dd></div>`;
  return `<section data-file-cloud-capture aria-label="Cloud source" style="overflow-wrap:anywhere">
    <p>Saved copy from <strong>${escape(value.source_label)}</strong></p>
    <p>Captured ${escape(new Date(value.captured_at).toLocaleString())}. Later cloud changes do not update this copy.</p>
    <details><summary>Source details</summary><dl>
      ${field('Original filename', value.filename)}
      ${value.export_as ? field('Exported filename', value.export_as.filename) + field('Export format', value.export_as.mime_type) : ''}
      ${value.path !== undefined ? field('Original location', value.path) : ''}
      ${field('Remote file ID', value.remote_id)}
      ${value.observed_revision !== undefined ? field('Cloud version seen in the file list', value.observed_revision) : ''}
      ${field('Content fingerprint (SHA-256)', value.content_hash)}
    </dl><p>The downloaded cloud version was not verified. The fingerprint identifies the saved content.</p></details>
  </section>`;
};
