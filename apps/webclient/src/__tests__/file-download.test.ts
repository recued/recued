import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { readStoredFileDownload } from '../files/file-preview.js';
import type { FileContentReadResponse } from '@recued/contracts';
const bytes = Buffer.from('Zoë,12\n'), hash = createHash('sha256').update(bytes).digest('hex');
const chunk = (offset: number): FileContentReadResponse => {
  const end = Math.min(bytes.length, offset + 3), part = bytes.subarray(offset, end);
  return { record_id: 'file:one', filename: 'output.csv', mime_type: 'text/csv', size_bytes: bytes.length,
    blob_hash: hash, content_hash: hash, offset, next_offset: end === bytes.length ? null : end,
    bytes_b64: part.toString('base64'), chunk_hash: createHash('sha256').update(part).digest('hex') };
};

it('reassembles split UTF-8 bytes and pins every later chunk to the first complete-file digest', async () => {
  const read = vi.fn(async ({ offset = 0 }) => chunk(offset));
  const result = await readStoredFileDownload({ record_id: 'file:one', size: bytes.length }, { read });
  expect(Buffer.from(result!.bytes).equals(bytes)).toBe(true);
  expect(read.mock.calls.slice(1).every(([args]) => 'expected_hash' in args && args.expected_hash === hash)).toBe(true);
});

it('refuses inconsistent chunks, truncated transfers and a forged complete-file digest', async () => {
  for (const corrupt of [
    (value: FileContentReadResponse) => ({ ...value, offset: 0 }),
    (value: FileContentReadResponse) => ({ ...value, next_offset: null }),
    (value: FileContentReadResponse) => ({ ...value, bytes_b64: Buffer.from('bad').toString('base64') }),
  ]) {
    const read = async ({ offset = 0 }) => offset ? corrupt(chunk(offset)) : chunk(offset);
    await expect(readStoredFileDownload({ record_id: 'file:one' }, { read })).rejects.toThrow();
  }
  await expect(readStoredFileDownload({ record_id: 'file:one' }, {
    read: async ({ offset = 0 }) => ({ ...chunk(offset), content_hash: 'a'.repeat(64) }),
  })).rejects.toThrow(/does not match/);
});

it('stops fetching and returns no file when the transfer is cancelled', async () => {
  const abort = new AbortController();
  const read = vi.fn(async () => { abort.abort(); return chunk(0); });
  expect(await readStoredFileDownload({ record_id: 'file:one' }, { read }, abort.signal)).toBeUndefined();
  expect(read).toHaveBeenCalledTimes(1);
});
