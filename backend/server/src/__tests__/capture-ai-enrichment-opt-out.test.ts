/** A pack's `response_capture.ai_enrichment: 'opt_out'`, through the server's
 *  REAL composition root and the REAL file intake.
 *
 *  ⛔ The gateway half (the binding's flag reaches `ingestFileDownload`) is
 *  pinned in the engine (`d-241-file-download-capture-runtime.test.ts`), and the
 *  producer half (a stamped record is refused) in `d-262-file-origin-gate.test.ts`.
 *  Neither sees the seam between them: `composeExecuteDeps` builds the ingestor
 *  that maps the gateway's input onto `inboundFileCollection.ingest`, and a
 *  mapping that drops one optional key would leave both halves green while every
 *  Home Assistant snapshot stayed captionable. So this goes through the composed
 *  ingestor into a real collection, reads the stored row back, and hands that
 *  row to the real caption producer.
 *
 *  Why the opt-out exists: a description of a camera frame serves no one in a
 *  home, and an unattended caption run would send every stored picture to the
 *  AI pool. It stops only the automation; the owner's own recipe can still
 *  send the file to an AI on purpose. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import {
  composeExecuteDeps,
  type ComposeExecuteDepsDeps,
} from '../composition/bin/wire-execute-deps.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createInboundFileCollection,
  type InboundFileCollection,
} from '../collections/file/inbound-file-collection.js';
import { mayAiEnrichFile } from '../housekeeping/producers/_file-media.js';
import { captionProducer } from '../housekeeping/producers/caption.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

let dir: string;
let files: InboundFileCollection;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capture-opt-out-'));
  files = createInboundFileCollection({
    db: new Database(':memory:'),
    blobs: createBlobStore(join(dir, 'cas')),
    gate: createStorageGate({ quota: 10 * 1024 * 1024, reservePct: 10, surface: 'collection:file:received' }),
    bus: createWarehouseEventBus(),
    slug: 'received',
    now: () => 1_700_000_000_000,
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The composed ingestor, with its presence asserted: an unwired one would
 *  otherwise surface as `undefined is not a function`. */
const composedIngestor = () => {
  const bundle = composeExecuteDeps({
    recipeStore: { get: vi.fn(() => null), ids: vi.fn(() => []) },
    executorConfig: { manifests: {} },
    baseVault: {},
    serverInstanceId: 'server-1',
    serverDisplayName: 'Server One',
    eventBus: { subscribe: vi.fn(), unsubscribe: vi.fn(), emit: vi.fn(), replay: vi.fn(() => []) },
    getExecuteDeps: vi.fn(() => undefined),
    inboundFileCollection: files,
  } as unknown as ComposeExecuteDepsDeps);
  const ingest = bundle.executeDeps.ingestFileDownload;
  if (ingest === undefined) throw new Error('composeExecuteDeps wired no file-download ingestor');
  return ingest;
};

/** A JPEG's first bytes: enough to be an image the caption producer wants. */
const PICTURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

const capture = (source_id: string, opt_out: boolean) => ({
  bytes_b64: PICTURE.toString('base64'),
  filename: 'camera-snapshot',
  mime_type: 'image/jpg',
  source_id,
  ...(opt_out ? { ai_enrichment: 'opt_out' as const } : {}),
});

/** Every AI capability throws: reaching any of them is the failure. */
const explodingCtx = (): HousekeepingContext => ({
  now: () => 1_700_000_000_000,
  emitAuditRow: () => undefined,
  blobs: {
    get: () => { throw new Error('read the bytes of an opted-out picture'); },
    getFile: () => { throw new Error('read the bytes of an opted-out picture'); },
  },
  llm: () => { throw new Error('sent an opted-out picture to the AI pool'); },
  llmWithMeta: () => { throw new Error('sent an opted-out picture to the AI pool'); },
} as never);

describe('a capture the pack opted out of AI enrichment, through the composed ingestor', () => {
  it('stores the opt-out on the file, and the caption producer leaves it alone', async () => {
    const { record_id } = await composedIngestor()(capture('run-1:recued-core.home-assistant.camera.snapshot:camera.front_door', true));
    const stored = files.get(record_id);
    expect(stored?.hot_fields).toMatchObject({
      origin: 'connection_download', media_class: 'image', ai_enrichment: 'opt_out',
    });
    expect(mayAiEnrichFile(stored!)).toBe(false);
    await expect(captionProducer.produce(explodingCtx(), { id: record_id, data: stored! } as never))
      .resolves.toBeNull();
  });

  it('leaves a capture without the opt-out to its origin, so the stamp is not a default', async () => {
    const { record_id } = await composedIngestor()(capture('run-1:recued-core.gdrive.file.download:abc', false));
    const stored = files.get(record_id);
    expect(stored?.hot_fields).not.toHaveProperty('ai_enrichment');
    expect(mayAiEnrichFile(stored!)).toBe(true);
  });

  it('keeps the opt-out when a second picture of the same camera rewrites the row', async () => {
    // The file id is run + action + target, so a second capture of the same
    // camera in one run rewrites the row rather than adding one.
    const ingest = composedIngestor();
    const source = 'run-2:recued-core.home-assistant.camera.snapshot:camera.front_door';
    const first = await ingest(capture(source, true));
    const second = await ingest(capture(source, true));
    expect(second.record_id).toBe(first.record_id);
    expect(files.get(second.record_id)?.hot_fields.ai_enrichment).toBe('opt_out');
  });
});
