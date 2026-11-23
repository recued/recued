/** Completed storage work survives a later browser-step failure. No file bytes or action inputs. */
export interface BrowserCompletedFile {
  step: number;
  file_ref: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  /** Present only for a PDF captured for the existing document-reader follow-up. */
  note?: string;
}
export const BROWSER_COMPLETED_FILES_CHARS = 2_500;
export const isBrowserCompletedFile = (value: unknown): value is BrowserCompletedFile => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(key => ['step', 'file_ref', 'filename', 'mime_type', 'size_bytes', 'note'].includes(key))
    && Number.isSafeInteger(v.step) && Number(v.step) >= 1 && Number(v.step) <= 20
    && typeof v.file_ref === 'string' && /^file:[0-9a-f]{32}$/.test(v.file_ref)
    && typeof v.filename === 'string' && v.filename.length > 0 && v.filename.length <= 255
    && typeof v.mime_type === 'string' && v.mime_type.length <= 128 && /^[\w.+-]+\/[\w.+-]+$/.test(v.mime_type)
    && Number.isSafeInteger(v.size_bytes) && Number(v.size_bytes) >= 0
    && (v.note === undefined || v.mime_type === 'application/pdf' && typeof v.note === 'string' && v.note.length <= 900);
};
export const completedBrowserFiles = (files: readonly unknown[]): {
  completed_files?: BrowserCompletedFile[]; completed_files_truncated?: true;
} => {
  if (!files.length) return {};
  const kept: BrowserCompletedFile[] = [];
  let truncated = false;
  for (const value of files) {
    if (!isBrowserCompletedFile(value) || kept.length >= 8
      || JSON.stringify([...kept, value]).length > BROWSER_COMPLETED_FILES_CHARS) { truncated = true; continue; }
    if (!kept.some(file => file.step === value.step && file.file_ref === value.file_ref)) kept.push(value);
  }
  return { completed_files: kept, ...(truncated ? { completed_files_truncated: true } : {}) };
};
