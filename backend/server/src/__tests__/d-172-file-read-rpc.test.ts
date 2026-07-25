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

const okFileReadDeps = (): FileReadDeps =>
  ({
    registry: {
      get: () => ({
        get: () => ({
          storage_ref: { kind: 'cas', blob_hash: BLOB_HASH },
          hot_fields: { mime_type: 'text/plain', filename: 'notes.txt' },
        }),
      }),
    },
    blobs: { get: async () => BYTES },
  }) as unknown as FileReadDeps;

const registered = { instance_id: 'inst-1' } as unknown as WsClient;
const unregistered = { instance_id: undefined } as unknown as WsClient;

describe('data.file.read pair-RPC handler (D-172 owner file read)', () => {
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
