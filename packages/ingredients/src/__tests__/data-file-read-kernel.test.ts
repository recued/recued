import { describe, expect, it } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
import { IngredientError } from '../types.js';

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
});

describe('kernel adapter — data-file-read', () => {
  it('routes to the data-file-read dispatcher and returns its result verbatim', async () => {
    let captured: unknown;
    const result = {
      record_id: 'file:abc',
      bytes_b64: 'eA==',
      mime_type: 'text/plain',
      filename: 'x.txt',
      size_bytes: 1,
      blob_hash: '1'.repeat(64),
    };
    const adapter = createKernelAdapter({
      dataFileRead: async (input) => {
        captured = input;
        return result;
      },
    });

    const out = await adapter(mkCall('data-file-read', {
      record_id: 'file:abc',
    }));

    expect(out).toBe(result);
    expect(captured).toEqual({ record_id: 'file:abc' });
  });

  it('verifies through the same dispatcher but strips bytes in metadata-only mode', async () => {
    const adapter = createKernelAdapter({
      dataFileRead: async () => ({
        record_id: 'file:pdf',
        bytes_b64: 'JVBERi0=',
        mime_type: 'application/pdf',
        filename: 'document.pdf',
        size_bytes: 5,
        blob_hash: '2'.repeat(64),
      }),
    });

    await expect(adapter(mkCall('data-file-read', {
      record_id: 'file:pdf',
      metadata_only: true,
    }))).resolves.toEqual({
      record_id: 'file:pdf',
      mime_type: 'application/pdf',
      filename: 'document.pdf',
      size_bytes: 5,
      blob_hash: '2'.repeat(64),
    });
  });

  it('throws SERVER_NOT_REACHABLE when the dispatcher is absent', async () => {
    const adapter = createKernelAdapter({});

    await expect(adapter(mkCall('data-file-read', {
      record_id: 'file:abc',
    }))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });

  it('rejects missing record_id with IngredientError', async () => {
    const adapter = createKernelAdapter({
      dataFileRead: async () => ({
        record_id: 'file:abc',
        bytes_b64: '',
        mime_type: 'text/plain',
        filename: 'x.txt',
        size_bytes: 0,
        blob_hash: '1'.repeat(64),
      }),
    });

    let caught: unknown;
    try {
      await adapter(mkCall('data-file-read', {}));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IngredientError);
    expect((caught as IngredientError).code).toBe('BAD_INPUT');
  });

  it('rejects a non-boolean metadata-only selector', async () => {
    const adapter = createKernelAdapter({
      dataFileRead: async () => ({
        record_id: 'file:abc',
        bytes_b64: '',
        mime_type: 'text/plain',
        filename: 'x.txt',
        size_bytes: 0,
        blob_hash: '1'.repeat(64),
      }),
    });

    await expect(adapter(mkCall('data-file-read', {
      record_id: 'file:abc',
      metadata_only: 'true',
    }))).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});
