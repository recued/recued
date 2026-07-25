/** D-172 P6 capstone — file-enrichment producers over `data.file`.
 *
 *  Drives the real per-record housekeeping harness with stubbed media/AI
 *  callables so the test covers producer output, media-class abstention,
 *  registry value schemas, and registration table wiring without reaching a
 *  network model.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type CollectionRecord,
  type EnrichmentTopic,
  type HousekeepingCursor,
} from '@recued/contracts';

import {
  buildEnrichmentProducerTask,
  enrichmentProducerAuthoredBy,
  type HousekeepingEnrichmentProducer,
} from '../housekeeping/enrichment-producer.js';
import { PER_RECORD_PRODUCERS } from '../housekeeping/registration.js';
import {
  captionProducer,
  extractedTextProducer,
  transcriptProducer,
} from '../housekeeping/index.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';
import type {
  SourceCollectionWalker,
  SourceRecord,
} from '../housekeeping/source-walkers.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { BlobStore } from '../storage/blob-store.js';

const NOW = 1_800_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
let blobsByHash: Map<string, Buffer>;
let transcribe: ReturnType<typeof vi.fn>;
let llmWithMeta: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-172-p6-file-producers-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createEnrichmentStore(db);
  blobsByHash = new Map();
  transcribe = vi.fn(async () => ({
    text: 'please schedule the demo',
    language: 'en',
    model_id: 'whisper-1',
  }));
  llmWithMeta = vi.fn(async (manifest, input: Record<string, unknown>) => {
    const parts = input['llm.content_parts'];
    expect(Array.isArray(parts)).toBe(true);
    if (manifest.slug === 'ai-generate') {
      return {
        result: { content: 'A concise caption of the uploaded image.' },
        model_id: 'openai:gpt-4o-mini',
      };
    }
    return {
      result: { text: 'Extracted document text.', page_count: 2 },
      model_id: 'google:gemini-2.0-flash',
    };
  });
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const buildBlobs = (): BlobStore => ({
  put: vi.fn(async (bytes: Buffer) => {
    const hash = `hash-${blobsByHash.size + 1}`;
    blobsByHash.set(hash, bytes);
    return hash;
  }),
  putFile: vi.fn(async (srcPath: string) => {
    const bytes = await readFile(srcPath);
    const hash = `hash-${blobsByHash.size + 1}`;
    blobsByHash.set(hash, bytes);
    return hash;
  }),
  get: vi.fn(async (hash: string) => blobsByHash.get(hash) ?? null),
  has: vi.fn(async (hash: string) => blobsByHash.has(hash)),
  delete: vi.fn(async (hash: string) => {
    blobsByHash.delete(hash);
  }),
  sizeOf: vi.fn(async (hash: string) => blobsByHash.get(hash)?.length ?? null),
  sweepOrphans: vi.fn(async () => 0),
  totalBytes: vi.fn(async () => 0),
  root: dir,
});

const buildCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => NOW,
  emitAuditRow: () => undefined,
  blobs: buildBlobs(),
  transcribe: transcribe as unknown as HousekeepingContext['transcribe'],
  llmWithMeta: llmWithMeta as unknown as HousekeepingContext['llmWithMeta'],
});

const fileRecord = (
  id: string,
  mediaClass: 'voice' | 'image' | 'document',
  mimeType: string,
  bytes: Buffer,
): CollectionRecord => {
  const blobHash = `${id}-hash`;
  blobsByHash.set(blobHash, bytes);
  return {
    record_id: id,
    received_at: NOW - 10_000,
    modified_at: NOW - 5_000,
    hot_fields: {
      filename: `${id}.bin`,
      mime_type: mimeType,
      size: bytes.length,
      content_hash: blobHash,
      origin: 'messenger_media',
      scan_status: 'clean',
      media_class: mediaClass,
    },
    size_bytes: bytes.length,
    source_id: id,
    blob_hash: blobHash,
    storage_ref: { kind: 'cas', blob_hash: blobHash },
  } as CollectionRecord & { storage_ref: { kind: 'cas'; blob_hash: string } };
};

const sourceRecord = (record: CollectionRecord): SourceRecord<CollectionRecord> => ({
  target_id: record.record_id,
  data: record,
  cursor_token: record.record_id,
});

const stubWalker = (
  records: SourceRecord<CollectionRecord>[],
): SourceCollectionWalker<CollectionRecord> => ({
  *walkAfter(cursor_token: string, batch_size: number) {
    let yielded = 0;
    for (const record of records) {
      if (record.cursor_token <= cursor_token) continue;
      if (yielded >= batch_size) return;
      yield record;
      yielded += 1;
    }
  },
  hashOf(record) {
    return `hash:${record.target_id}`;
  },
  fetchOne(target_id) {
    return records.find((r) => r.target_id === target_id) ?? null;
  },
});

const runProducer = async (
  producer: HousekeepingEnrichmentProducer<CollectionRecord>,
  record: CollectionRecord,
) => {
  const task = buildEnrichmentProducerTask({
    producer,
    walker: stubWalker([sourceRecord(record)]),
  });
  return task.step(
    buildCtx(),
    { kind: 'topic', topic: producer.topic, scope: 'file', max_target_id_seen: '' } as HousekeepingCursor,
    60_000,
  );
};

const rowFor = (topic: EnrichmentTopic, targetId: string) =>
  store.list({
    topic,
    scope: 'file',
    target_id: targetId,
    authored_by: enrichmentProducerAuthoredBy(topic),
    fresh_only: true,
    limit: 1,
  })[0];

describe('D-172 P6 file-enrichment producer capstone', () => {
  it('writes conformant transcript/caption/extracted_text rows through the real per-record harness', async () => {
    const voice = fileRecord('voice-1', 'voice', 'audio/wav', Buffer.from('voice bytes'));
    const image = fileRecord('image-1', 'image', 'image/png', Buffer.from('image bytes'));
    const document = fileRecord('doc-1', 'document', 'application/pdf', Buffer.from('document bytes'));

    await expect(runProducer(transcriptProducer, voice)).resolves.toMatchObject({ status: 'complete' });
    await expect(runProducer(captionProducer, image)).resolves.toMatchObject({ status: 'complete' });
    await expect(runProducer(extractedTextProducer, document)).resolves.toMatchObject({ status: 'complete' });

    const transcriptRow = rowFor('transcript', 'voice-1');
    const captionRow = rowFor('caption', 'image-1');
    const extractedTextRow = rowFor('extracted_text', 'doc-1');

    expect(ENRICHMENT_REGISTRY.transcript.value_schema(transcriptRow?.value).ok).toBe(true);
    expect(transcriptRow?.value).toEqual({
      text: 'please schedule the demo',
      language: 'en',
      model: 'whisper-1',
    });
    expect(transcriptRow?.event_at).toBe(voice.modified_at);
    expect(transcriptRow?.model_id).toBe('whisper-1');

    expect(ENRICHMENT_REGISTRY.caption.value_schema(captionRow?.value).ok).toBe(true);
    expect(captionRow?.value).toEqual({
      caption: 'A concise caption of the uploaded image.',
      model: 'openai:gpt-4o-mini',
    });

    expect(ENRICHMENT_REGISTRY.extracted_text.value_schema(extractedTextRow?.value).ok).toBe(true);
    expect(extractedTextRow?.value).toEqual({
      text: 'Extracted document text.',
      page_count: 2,
      model: 'google:gemini-2.0-flash',
    });

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0]?.[0]).toMatchObject({
      mime_type: 'audio/wav',
      filename: 'voice-1.bin',
    });
    expect(Buffer.from(transcribe.mock.calls[0]?.[0].audio)).toEqual(Buffer.from('voice bytes'));

    expect(llmWithMeta).toHaveBeenCalledTimes(2);
    const captionInput = llmWithMeta.mock.calls[0]?.[1] as Record<string, unknown>;
    const extractedInput = llmWithMeta.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(captionInput['llm.content_parts']).toEqual([
      {
        type: 'image',
        source: {
          kind: 'base64',
          media_type: 'image/png',
          data: Buffer.from('image bytes').toString('base64'),
        },
      },
    ]);
    expect(extractedInput['llm.content_parts']).toEqual([
      {
        type: 'document',
        source: {
          kind: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from('document bytes').toString('base64'),
        },
      },
    ]);
  });

  it('skips the wrong media_class and registers all three topics on the file walker', async () => {
    const image = fileRecord('wrong-1', 'image', 'image/png', Buffer.from('image bytes'));

    await expect(runProducer(transcriptProducer, image)).resolves.toMatchObject({ status: 'complete' });

    expect(rowFor('transcript', 'wrong-1')).toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();

    const fileEntries = PER_RECORD_PRODUCERS
      .filter((entry) => entry.walker_kind === 'file')
      .map((entry) => entry.producer.topic)
      .sort();
    expect(fileEntries).toEqual(['caption', 'extracted_text', 'transcript']);
  });
});
