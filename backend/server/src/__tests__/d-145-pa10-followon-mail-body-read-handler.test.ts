import { Buffer } from 'node:buffer';

import { RpcError, type CollectionRecord } from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { CollectionRegistry } from '../collections/registry.js';
import type { Collection } from '../collections/types.js';
import {
  handleMailBodyRead,
  materializeMailBody,
  MAX_BODY_CHARS,
} from '../mail-body-read-handler.js';
import type { BlobStore } from '../storage/blob-store.js';

type BlobEntry = string | Buffer;

const makeRecord = (overrides: Partial<CollectionRecord> = {}): CollectionRecord => ({
  record_id: 'msg-1',
  received_at: 1,
  modified_at: 2,
  hot_fields: {},
  size_bytes: 0,
  source_id: 'source-1',
  ...overrides,
});

const makeCollection = (records: CollectionRecord[]): Collection => {
  const byId = new Map<string, CollectionRecord>(
    records.map((record): [string, CollectionRecord] => [record.record_id, record]),
  );
  return {
    get: (record_id: string) => byId.get(record_id) ?? null,
  } as unknown as Collection;
};

const makeRegistry = (collection: Collection): CollectionRegistry => ({
  get: (platform: string, slug: string) =>
    platform === 'mail' && slug === 'gmail' ? collection : undefined,
} as unknown as CollectionRegistry);

const makeBlobs = (entries: Record<string, BlobEntry> = {}) => {
  const byHash = new Map<string, Buffer>(
    Object.entries(entries).map(([hash, body]): [string, Buffer] => [
      hash,
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'),
    ]),
  );
  const get = vi.fn(async (hash: string) => byHash.get(hash) ?? null);
  return {
    blobs: { get } as unknown as BlobStore,
    get,
  };
};

const makeDeps = (
  records: CollectionRecord[],
  blobEntries: Record<string, BlobEntry> = {},
) => {
  const { blobs, get } = makeBlobs(blobEntries);
  return {
    deps: {
      registry: makeRegistry(makeCollection(records)),
      blobs,
    },
    getBlob: get,
  };
};

const expectRpcError = async (
  promise: Promise<unknown>,
  code: string,
): Promise<void> => {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(RpcError);
  expect((caught as RpcError).code).toBe(code);
};

describe('handleMailBodyRead', () => {
  it('returns an inline non-empty body', async () => {
    const record = makeRecord({ body_inline: 'hello mail', size_bytes: 10 });
    const { deps } = makeDeps([record]);

    await expect(handleMailBodyRead(deps, {
      slug: 'gmail',
      record_id: 'msg-1',
    })).resolves.toEqual({
      body: 'hello mail',
      found: true,
      size_bytes: 10,
      truncated: false,
    });
  });

  it("preserves an empty inline body as '' instead of null", async () => {
    const record = makeRecord({ body_inline: '', size_bytes: 0 });
    const { deps } = makeDeps([record]);

    await expect(handleMailBodyRead(deps, {
      slug: 'gmail',
      record_id: 'msg-1',
    })).resolves.toEqual({
      body: '',
      found: true,
      size_bytes: 0,
      truncated: false,
    });
  });

  it('materializes a CAS-spilled body via blob_hash', async () => {
    const record = makeRecord({ blob_hash: 'hash-1', size_bytes: 12 });
    const { deps, getBlob } = makeDeps([record], { 'hash-1': 'spilled body' });

    await expect(handleMailBodyRead(deps, {
      slug: 'gmail',
      record_id: 'msg-1',
    })).resolves.toEqual({
      body: 'spilled body',
      found: true,
      size_bytes: 12,
      truncated: false,
    });
    expect(getBlob).toHaveBeenCalledTimes(1);
    expect(getBlob).toHaveBeenCalledWith('hash-1');
  });

  it('keeps found true when the CAS blob is missing', async () => {
    const record = makeRecord({ blob_hash: 'missing-hash', size_bytes: 99 });
    const { deps } = makeDeps([record]);

    await expect(handleMailBodyRead(deps, {
      slug: 'gmail',
      record_id: 'msg-1',
    })).resolves.toEqual({
      body: null,
      found: true,
      size_bytes: 99,
      truncated: false,
    });
  });

  it('keeps found true when the record carries no body pointer', async () => {
    const record = makeRecord({ size_bytes: 42 });
    const { deps } = makeDeps([record]);

    await expect(handleMailBodyRead(deps, {
      slug: 'gmail',
      record_id: 'msg-1',
    })).resolves.toEqual({
      body: null,
      found: true,
      size_bytes: 42,
      truncated: false,
    });
  });

  it('returns found false for a missing record', async () => {
    const { deps } = makeDeps([]);

    await expect(handleMailBodyRead(deps, {
      slug: 'gmail',
      record_id: 'msg-404',
    })).resolves.toEqual({
      body: null,
      found: false,
      size_bytes: 0,
      truncated: false,
    });
  });

  it("rejects an unknown collection slug with RpcError('collection_not_found')", async () => {
    const { deps } = makeDeps([makeRecord()]);

    await expectRpcError(handleMailBodyRead(deps, {
      slug: 'outlook',
      record_id: 'msg-1',
    }), 'collection_not_found');
  });

  it.each([
    ['missing slug', { record_id: 'msg-1' }],
    ['empty slug', { slug: '', record_id: 'msg-1' }],
  ])("rejects %s with RpcError('bad_request')", async (_label, args) => {
    const { deps } = makeDeps([makeRecord()]);

    await expectRpcError(handleMailBodyRead(deps, args), 'bad_request');
  });

  it.each([
    ['missing record_id', { slug: 'gmail' }],
    ['empty record_id', { slug: 'gmail', record_id: '' }],
  ])("rejects %s with RpcError('bad_request')", async (_label, args) => {
    const { deps } = makeDeps([makeRecord()]);

    await expectRpcError(handleMailBodyRead(deps, args), 'bad_request');
  });

  it.each([0, -5, 1.5, 'x'])(
    "rejects invalid max_chars %s with RpcError('bad_request')",
    async (max_chars) => {
      const { deps } = makeDeps([makeRecord({ body_inline: 'abcdef', size_bytes: 6 })]);

      await expectRpcError(handleMailBodyRead(deps, {
        slug: 'gmail',
        record_id: 'msg-1',
        max_chars,
      }), 'bad_request');
    },
  );

  it('truncates when max_chars is shorter than the body', async () => {
    const record = makeRecord({ body_inline: 'abcdef', size_bytes: 6 });
    const { deps } = makeDeps([record]);

    await expect(handleMailBodyRead(deps, {
      slug: 'gmail',
      record_id: 'msg-1',
      max_chars: 3,
    })).resolves.toEqual({
      body: 'abc',
      found: true,
      size_bytes: 6,
      truncated: true,
    });
  });

  it('does not truncate when max_chars is longer than the body', async () => {
    const record = makeRecord({ body_inline: 'abcdef', size_bytes: 6 });
    const { deps } = makeDeps([record]);

    await expect(handleMailBodyRead(deps, {
      slug: 'gmail',
      record_id: 'msg-1',
      max_chars: 99,
    })).resolves.toEqual({
      body: 'abcdef',
      found: true,
      size_bytes: 6,
      truncated: false,
    });
  });

  it('does not truncate when max_chars exactly equals the body length', async () => {
    const record = makeRecord({ body_inline: 'abcdef', size_bytes: 6 });
    const { deps } = makeDeps([record]);

    await expect(handleMailBodyRead(deps, {
      slug: 'gmail',
      record_id: 'msg-1',
      max_chars: 6,
    })).resolves.toEqual({
      body: 'abcdef',
      found: true,
      size_bytes: 6,
      truncated: false,
    });
  });

  it('applies MAX_BODY_CHARS when max_chars is omitted', async () => {
    const oversized = 'x'.repeat(MAX_BODY_CHARS + 10);
    const record = makeRecord({
      body_inline: oversized,
      size_bytes: oversized.length,
    });
    const { deps } = makeDeps([record]);

    const out = await handleMailBodyRead(deps, {
      slug: 'gmail',
      record_id: 'msg-1',
    });

    expect(out.found).toBe(true);
    expect(out.size_bytes).toBe(oversized.length);
    expect(out.truncated).toBe(true);
    expect(out.body).toHaveLength(MAX_BODY_CHARS);
  });

  it('clamps max_chars above MAX_BODY_CHARS to the hard ceiling', async () => {
    const oversized = 'x'.repeat(MAX_BODY_CHARS + 10);
    const record = makeRecord({
      body_inline: oversized,
      size_bytes: oversized.length,
    });
    const { deps } = makeDeps([record]);

    const out = await handleMailBodyRead(deps, {
      slug: 'gmail',
      record_id: 'msg-1',
      max_chars: MAX_BODY_CHARS + 100,
    });

    expect(out.found).toBe(true);
    expect(out.size_bytes).toBe(oversized.length);
    expect(out.truncated).toBe(true);
    expect(out.body).toHaveLength(MAX_BODY_CHARS);
  });
});

describe('materializeMailBody', () => {
  it("returns '' for an inline empty body", async () => {
    const { blobs } = makeBlobs();

    await expect(materializeMailBody(
      makeRecord({ body_inline: '', size_bytes: 0 }),
      blobs,
    )).resolves.toBe('');
  });

  it('returns inline non-empty body text', async () => {
    const { blobs } = makeBlobs();

    await expect(materializeMailBody(
      makeRecord({ body_inline: 'hi', size_bytes: 2 }),
      blobs,
    )).resolves.toBe('hi');
  });

  it('returns utf8 text for a blob_hash hit', async () => {
    const { blobs, get } = makeBlobs({ 'hash-1': 'from blob' });

    await expect(materializeMailBody(
      makeRecord({ blob_hash: 'hash-1', size_bytes: 9 }),
      blobs,
    )).resolves.toBe('from blob');
    expect(get).toHaveBeenCalledWith('hash-1');
  });

  it('returns null for a blob_hash miss', async () => {
    const { blobs } = makeBlobs();

    await expect(materializeMailBody(
      makeRecord({ blob_hash: 'missing', size_bytes: 9 }),
      blobs,
    )).resolves.toBeNull();
  });

  it('returns null when neither inline body nor blob_hash exists', async () => {
    const { blobs } = makeBlobs();

    await expect(materializeMailBody(
      makeRecord({ size_bytes: 0 }),
      blobs,
    )).resolves.toBeNull();
  });
});
