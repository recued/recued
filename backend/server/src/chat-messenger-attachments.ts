import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboundFileCollection } from './collections/file/inbound-file-collection.js';

/** Only this immutable descriptor enters the encrypted outbox. A retry must
 * never substitute newer bytes behind the original retained file reference. */
export interface MessengerAttachmentPlan {
  file_id: string;
  blob_hash: string;
  filename: string;
  mime_type: string;
  size: number;
}
export class MessengerAttachmentError extends Error {
  constructor(readonly code: 'attachment_unavailable' | 'attachment_changed' | 'attachment_blocked' | 'attachment_unsupported') {
    super(code);
  }
}
export interface MessengerAttachmentSource {
  /** Display metadata only; this never authorizes an upload or opens bytes. */
  describe?(file_id: string): { filename: string } | undefined;
  snapshot(file_id: string): MessengerAttachmentPlan;
  validate(plan: MessengerAttachmentPlan): void;
  open(plan: MessengerAttachmentPlan): Promise<{ path: string; dispose(): Promise<void> }>;
}
export const parseMessengerAttachmentPlan = (text: string): MessengerAttachmentPlan => {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || !('file_id' in value) || typeof value.file_id !== 'string'
    || !('blob_hash' in value) || typeof value.blob_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.blob_hash)
    || !('filename' in value) || typeof value.filename !== 'string'
    || !('mime_type' in value) || typeof value.mime_type !== 'string'
    || !('size' in value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new MessengerAttachmentError('attachment_unavailable');
  }
  return { file_id: value.file_id, blob_hash: value.blob_hash, filename: value.filename, mime_type: value.mime_type, size: value.size };
};

const processStarted = Math.round(Date.now() - process.uptime() * 1000);
const workerAlive = (pid: number, started: number): boolean => {
  if (pid === process.pid) return Math.abs(started - processStarted) < 2000;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ESRCH'); }
};

export const createMessengerAttachmentSource = (files: InboundFileCollection, scratchDir = tmpdir()): MessengerAttachmentSource => {
  // A process crash cannot run finally. Reclaim only this feature's scratch
  // from dead workers on startup; another live backend may be uploading from
  // the same data volume. Unknown ownership is deliberately left untouched.
  const reclaimed = (async () => {
    const entries = await readdir(scratchDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const owner = /^messenger-mirror-(\d+)-(\d+)-/.exec(entry.name);
      if (!entry.isDirectory() || !owner) continue;
      const pid = Number(owner[1]); const started = Number(owner[2]);
      if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(started) && !workerAlive(pid, started)) {
        await rm(join(scratchDir, entry.name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  })();
  const snapshot = (file_id: string): MessengerAttachmentPlan => {
    const record = files.get(file_id);
    if (!record || record.storage_ref.kind !== 'cas' || !files.copyToFile) throw new MessengerAttachmentError('attachment_unavailable');
    const hot = record.hot_fields;
    if (hot.scan_status === 'flagged' || hot.scan_status === 'pending') throw new MessengerAttachmentError('attachment_blocked');
    if (hot.content_hash !== record.storage_ref.blob_hash) throw new MessengerAttachmentError('attachment_changed');
    return parseMessengerAttachmentPlan(JSON.stringify({ file_id, blob_hash: record.storage_ref.blob_hash,
      filename: hot.filename, mime_type: hot.mime_type, size: hot.size,
    }));
  };
  const retainedId = (plan: MessengerAttachmentPlan): string => files.attachmentLifecycle?.resolveSnapshot(
    plan.file_id, plan.blob_hash, plan.filename, plan.mime_type, plan.size) ?? plan.file_id;
  const validate = (plan: MessengerAttachmentPlan): void => {
    const current = snapshot(retainedId(plan));
    if (current.blob_hash !== plan.blob_hash || current.size !== plan.size || current.filename !== plan.filename || current.mime_type !== plan.mime_type) {
      throw new MessengerAttachmentError('attachment_changed');
    }
  };
  return { snapshot, validate,
    describe: file_id => {
      const record = files.get(file_id);
      return record ? { filename: record.hot_fields.filename } : undefined;
    },
    async open(plan) {
      let release: (() => void) | undefined;
      try {
        validate(plan);
        const fileId = retainedId(plan);
        release = files.attachmentLifecycle?.lease(fileId, plan.blob_hash);
        await reclaimed;
        await mkdir(scratchDir, { recursive: true, mode: 0o700 });
        const dir = await mkdtemp(join(scratchDir, `messenger-mirror-${process.pid}-${processStarted}-`));
        const path = join(dir, 'attachment');
        const dispose = async () => { try { await rm(dir, { recursive: true, force: true }); } finally { release?.(); } };
        try {
          await files.copyToFile!(fileId, path);
          // AEAD verifies the encrypted blob first. Also verify the content
          // address and length before any vendor can observe a byte.
          const hash = createHash('sha256'); let size = 0;
          for await (const part of createReadStream(path)) { size += part.length; hash.update(part); }
          if (size !== plan.size || hash.digest('hex') !== plan.blob_hash) throw new MessengerAttachmentError('attachment_changed');
          validate(plan);
          return { path, dispose };
        } catch (error) {
          await dispose();
          throw error instanceof MessengerAttachmentError ? error : new MessengerAttachmentError('attachment_unavailable');
        }
      } catch (error) { release?.(); throw error instanceof MessengerAttachmentError ? error : new MessengerAttachmentError('attachment_unavailable'); }
    },
  };
};
