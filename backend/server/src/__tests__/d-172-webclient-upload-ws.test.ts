/** D-172 resumable uploads — webclient binary `/ws/upload` socket integration.
 *
 *  The service unit tests (`upload/__tests__/webclient-upload-service.test.ts`)
 *  drive `handleChunkFrame` directly with an explicit scope_key. This suite
 *  closes the ONE seam they can't: the REAL socket path — a binary chunk frame
 *  travels a live `/ws/upload` WebSocket, the upgrade verifies the structured
 *  bearer, resolves `token_instance_id` as the scope_key, dispatches to the
 *  service, and acks as JSON text. Pins: happy-path chunk-over-the-wire,
 *  auth-reject (bad / missing bearer), and SCOPE isolation enforced by the
 *  socket's OWN verified identity (a frame for another scope's upload → forbidden
 *  even though the upload_id is correct). Mirrors `d-148-ws-bearer-verify`. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { encodeUploadChunkFrame } from '@recued/contracts';

import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { createWebclientUploadService } from '../upload/webclient-upload-service.js';

const FAST_ARGON2 = { t: 1, m: 8, p: 1 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connect to `/ws/upload`, send `frame` on open, resolve with the first ack
 *  message (parsed) — or `{ opened: false }` if the upgrade is rejected. */
const sendFrame = (
  port: number,
  token: string,
  frame: Uint8Array | null,
): Promise<{ opened: boolean; ack?: unknown }> =>
  new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/upload?token=${encodeURIComponent(token)}`,
    );
    ws.binaryType = 'nodebuffer';
    let settled = false;
    const done = (v: { opened: boolean; ack?: unknown }) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(v);
    };
    ws.on('open', () => {
      if (frame === null) { done({ opened: true }); return; }
      ws.send(frame);
    });
    ws.on('message', (data: Buffer) => {
      let ack: unknown;
      try { ack = JSON.parse(data.toString()); } catch { ack = undefined; }
      done({ opened: true, ack });
    });
    ws.on('error', () => done({ opened: false }));
    ws.on('unexpected-response', () => done({ opened: false }));
  });

describe('D-172 — webclient /ws/upload binary socket', () => {
  let server: RunningServer | undefined;
  let db: Database.Database;
  let dir: string;
  let tid: string;
  let bearer: string;
  let service: ReturnType<typeof createWebclientUploadService>;
  const SCOPE = 'instance_owner';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'upload-ws-'));
    db = new Database(':memory:');
    const blobs = createBlobStore(join(dir, 'cas'));
    const files = createInboundFileCollection({
      db,
      blobs,
      gate: createStorageGate({ quota: 64 * 1024 * 1024, reservePct: 10, surface: 'collection:file:received' }),
      bus: createWarehouseEventBus(),
      slug: 'received',
    });
    service = createWebclientUploadService({
      db,
      blobs,
      uploadsRoot: join(dir, 'upload_blobs'),
      inboundFileCollection: files,
      sizeCapBytes: 1_000_000,
    });

    const clientTokens = createClientTokenStore(db, { argon2_params: FAST_ARGON2 });
    // The token carries `metadata.instance_id` so the upgrade resolves
    // `token_instance_id` = the scope_key (a bearer-only webclient identity).
    const issued = await clientTokens.issue({
      client_kind: 'webclient',
      client_label: 'Owner webclient',
      metadata: { instance_id: SCOPE },
    });
    tid = issued.token_id;
    bearer = issued.bearer;

    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');
    server = await startServer(0, {
      executeDeps: { recipeStore, executorConfig: { manifests }, baseVault: {} },
      clientTokens,
      uploadDeps: { service },
    });
    server!.wsServer.maxInstances = 0;
  });

  afterAll(async () => {
    await server?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a valid bearer + a chunk frame over the wire acks ok (scope from token_instance_id)', async () => {
    const body = Buffer.from('bytes over the real socket');
    const create = await service.create({
      scope_key: SCOPE,
      filename: 'wire.bin',
      declared_size: body.length,
      mime_reported: 'application/octet-stream',
    });
    expect(create.status).toBe('created');
    if (create.status !== 'created') throw new Error('unreachable');

    const frame = encodeUploadChunkFrame({ req_id: 'r1', upload_id: create.upload_id, offset: 0 }, body);
    const { opened, ack } = await sendFrame(server!.port, `${tid}.${bearer}`, frame);
    expect(opened).toBe(true);
    expect(ack).toMatchObject({ type: 'upload_ack', req_id: 'r1', ok: true, offset: body.length, complete: true });

    // The bytes really landed — finalize materializes the record.
    const fin = await service.finalize({ scope_key: SCOPE, upload_id: create.upload_id });
    expect(fin.status).toBe('finalized');
  });

  it('a bad bearer is rejected at upgrade (no socket)', async () => {
    const { opened } = await sendFrame(server!.port, 'not-a-valid-structured-bearer', null);
    expect(opened).toBe(false);
  });

  it('a chunk frame for an upload owned by ANOTHER scope acks forbidden (socket identity wins)', async () => {
    // Session created under a DIFFERENT scope than the connecting token's
    // instance_id. The socket resolves scope = SCOPE (from its bearer); the
    // session belongs to 'other_instance', so handleChunkFrame must refuse.
    const body = Buffer.from('not yours');
    const create = await service.create({
      scope_key: 'other_instance',
      filename: 'other.bin',
      declared_size: body.length,
      mime_reported: 'application/octet-stream',
    });
    if (create.status !== 'created') throw new Error('unreachable');
    const frame = encodeUploadChunkFrame({ req_id: 'r2', upload_id: create.upload_id, offset: 0 }, body);
    const { opened, ack } = await sendFrame(server!.port, `${tid}.${bearer}`, frame);
    expect(opened).toBe(true);
    expect(ack).toMatchObject({ type: 'upload_ack', req_id: 'r2', ok: false, reason: 'forbidden' });
  });
});
