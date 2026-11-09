/** D-335 slice AP — files between the browser and the owner's files: one handoff every browser step uses.
 *
 *  The owner: "for #4 and #5 it should be generic so a downlod file & table->csv file can be into the game
 *  later". A file a browser step brings in (a download now, a table saved as CSV later) is kept among the
 *  owner's files, in `data.file.received`, as the CSV Toolkit keeps what it writes, and the step answers its
 *  `file:` ref, which Read a PDF's text, `document.read`, the CSV Toolkit and a mail's attachments all take.
 *  A step that puts a file into a page (an upload) reads one by that ref. A file's bytes never ride in a
 *  step's output, its history or the audit, only its ref and what it is.
 *
 *  ⚠ How the bytes travel is not part of this: a download comes from the Bridge in one answer of at most
 *  `BRIDGE_FILE_MAX_BYTES` (`@recued/contracts`); a larger one could come over the chunked upload sockets
 *  (D-172) to this same place, its ref the same. */

import { createHash } from 'node:crypto';

/** What a browser step answers for a file it kept: its ref and what it is, never its bytes. */
export interface BrowserFileKept {
  readonly file_ref: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
}

export interface BrowserFiles {
  /** Keep `bytes` among the owner's files. `run_id` and `step_id` name the step it came from, so the
   *  same file kept by two steps is two files, and one step keeping it again is the same one. */
  keep(input: { bytes: Buffer; filename: string; mime_type: string; run_id?: string; step_id?: string;
    /** Where it came from: a page in the browser (the default), or the server's own fetch (D-345). */
    origin?: KeptFileOrigin }): Promise<BrowserFileKept>;
  /** A kept file's bytes and what it is, by its `file:` ref. */
  read(file_ref: string): Promise<{ bytes: Buffer; filename: string; mime_type: string }>;
  /** Slice AQ — what a kept file is, without its bytes, for an ask to name it; undefined for no such file. */
  about(file_ref: string): { filename: string; mime_type: string; size_bytes: number } | undefined;
}

/** Where a kept file came from: a page in the browser (D-335 slice AP), or the server's own fetch of a
 *  web address (D-345). */
export type KeptFileOrigin = 'browser_download' | 'http_download';

/** The part of the owner's files a browser step uses: `data.file.received`'s own `ingest` and `readBytes`. */
export interface BrowserFilesCollection {
  ingest(input: { bytes: Buffer; filename: string; mime_type: string; content_hash: string; origin: KeptFileOrigin;
    source_id: string }): Promise<{ record_id: string; hot_fields?: Record<string, unknown> }>;
  readBytes(record_id: string): Promise<{ bytes: Buffer; mime_type: string; filename: string }>;
  get(record_id: string): { hot_fields: Record<string, unknown> } | null;
}

/** The handoff over `collection`, looked up when a step uses it: the owner's files open after the
 *  executor is built. */
export const createBrowserFiles = (collection: () => BrowserFilesCollection | undefined): BrowserFiles => {
  const files = (): BrowserFilesCollection => {
    const found = collection();
    if (found === undefined) throw new Error('The owner\'s files are not open on this server, so a file cannot be kept or read.');
    return found;
  };
  return {
    async keep({ bytes, filename, mime_type, run_id, step_id, origin = 'browser_download' }) {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const record = await files().ingest({ bytes, filename, mime_type, content_hash: sha256, origin,
        source_id: `${run_id ?? 'browser'}:${step_id ?? 'file'}:${sha256}` });
      // The name as the owner's files keep it, which they make safe and short.
      const kept = record.hot_fields?.filename;
      return { file_ref: record.record_id, filename: typeof kept === 'string' && kept !== '' ? kept : filename, mime_type,
        size_bytes: bytes.length, sha256 };
    },
    read: (file_ref) => files().readBytes(file_ref),
    about(file_ref) {
      const found = collection()?.get(file_ref);
      const { filename, mime_type, size } = found?.hot_fields ?? {};
      return typeof filename === 'string' && typeof mime_type === 'string' && typeof size === 'number'
        ? { filename, mime_type, size_bytes: size } : undefined;
    },
  };
};
