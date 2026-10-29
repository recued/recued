import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  handleDataFileRead,
  makeFileReadRpcHandlers,
} from '../file-read-rpc-handler.js';
import type { FileReadDeps } from '../collections/file/file-read-handler.js';
import type { WsClient } from '../ws-server.js';

// Minimal FileReadDeps mirroring handleFileRead's resolution: registry →
// collection → record (storage_ref + hot_fields), blobs → bytes (a Buffer).
//
// ⚠ D-200 (2789eaef5) added a CAS integrity check: `handleFileRead` re-hashes
// the retrieved bytes and refuses if they do not match the claimed content
// address (file-read-handler.ts:170-176). The hash is DERIVED from the fixture
// bytes rather than hand-spelled, so the two can never drift apart again — a
// literal 'h1' is what made this red.
const BYTES = Buffer.from('hi');
const BLOB_HASH = createHash('sha256').update(BYTES).digest('hex');

const okFileReadDeps = (source: () => Buffer | null = () => BYTES): FileReadDeps =>
  ({
    registry: {
      get: () => ({
        get: () => source() === null ? null : ({
          storage_ref: { kind: 'cas', blob_hash: createHash('sha256').update(source()!).digest('hex') },
          hot_fields: { mime_type: 'text/plain', filename: 'notes.txt' },
        }),
      }),
    },
    blobs: { get: async () => source() },
  }) as unknown as FileReadDeps;

const registered = { instance_id: 'inst-1' } as unknown as WsClient;
const unregistered = { instance_id: undefined } as unknown as WsClient;

describe('data.file.read pair-RPC handler (D-172 owner file read)', () => {
  it('returns bounded, digest-pinned chunks while preserving the whole-file response', async () => {
    const bytes = Buffer.from('abcdefgh'), hash = createHash('sha256').update(bytes).digest('hex');
    const deps = okFileReadDeps(() => bytes), handlers = makeFileReadRpcHandlers({ getFileReadDeps: () => deps })!.handlers;
    const first = await handlers['data.file.read']({ record_id: 'rec-1', offset: 0, length: 3 }, registered);
    expect(first).toMatchObject({ size_bytes: 8, bytes_b64: Buffer.from('abc').toString('base64'), offset: 0, next_offset: 3, content_hash: hash,
      chunk_hash: createHash('sha256').update('abc').digest('hex') });
    const last = await handlers['data.file.read']({ record_id: 'rec-1', offset: 6, length: 3, expected_hash: hash }, registered);
    expect(last).toMatchObject({ size_bytes: 8, bytes_b64: Buffer.from('gh').toString('base64'), next_offset: null });
    const empty = await handlers['data.file.read']({ record_id: 'rec-1', offset: 8, length: 3, expected_hash: hash }, registered);
    expect(empty).toMatchObject({ bytes_b64: '', next_offset: null });
    const whole = await handlers['data.file.read']({ record_id: 'rec-1' }, registered);
    expect(whole.bytes_b64).toBe(bytes.toString('base64')); expect(whole.offset).toBeUndefined();
  });
  it('refuses changed/deleted sources and invalid ranges, retaining paired-client authorization', async () => {
    let source: Buffer | null = BYTES;
    const deps = okFileReadDeps(() => source), handlers = makeFileReadRpcHandlers({ getFileReadDeps: () => deps })!.handlers;
    const args = { record_id: 'rec-1', offset: 0, length: 1, expected_hash: BLOB_HASH };
    await expect(handlers['data.file.read'](args, unregistered)).rejects.toMatchObject({ code: 'unauthorized' });
    for (const change of [{ offset: -1 }, { offset: 0.5 }, { offset: 100 }, { length: 0 }, { length: 4194305 }, { expected_hash: 'wrong' }]) {
      await expect(handlers['data.file.read']({ ...args, ...change }, registered)).rejects.toMatchObject({ code: 'bad_request' });
    }
    source = Buffer.from('changed');
    await expect(handlers['data.file.read'](args, registered)).rejects.toMatchObject({ code: 'file_changed' });
    source = null;
    await expect(handlers['data.file.read'](args, registered)).rejects.toMatchObject({ code: 'file_not_found' });
  });
  it('makeFileReadRpcHandlers is undefined without deps', () => {
    expect(makeFileReadRpcHandlers(undefined)).toBeUndefined();
  });

  it('rejects an unregistered client (the owner-trust boundary)', async () => {
    const slice = makeFileReadRpcHandlers({ getFileReadDeps: okFileReadDeps })!;
    await expect(
      slice.handlers['data.file.read']({ record_id: 'rec-1' }, unregistered),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('returns not_configured when the file collection is unwired', async () => {
    await expect(
      handleDataFileRead({ getFileReadDeps: () => undefined }, { record_id: 'rec-1' }),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('requires a record_id', async () => {
    await expect(
      handleDataFileRead({ getFileReadDeps: okFileReadDeps }, { record_id: '' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('reads bytes through handleFileRead for a registered owner client (no contract gate)', async () => {
    const slice = makeFileReadRpcHandlers({ getFileReadDeps: okFileReadDeps })!;
    const res = await slice.handlers['data.file.read']({ record_id: 'rec-1' }, registered);
    expect(res).toMatchObject({
      record_id: 'rec-1',
      bytes_b64: BYTES.toString('base64'),
      mime_type: 'text/plain',
      filename: 'notes.txt',
      size_bytes: 2,
      blob_hash: BLOB_HASH,
    });
  });
});
