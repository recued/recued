/** M4b.1 — archive-upload binary `/ws/archive-upload` socket integration.
 *
 *  The service unit tests (`archive/__tests__/archive-upload-service.test.ts`)
 *  drive `handleChunkFrame` directly with an explicit scope_key. This suite
 *  closes the ONE seam they can't: the REAL socket path — a binary chunk frame
 *  travels a live `/ws/archive-upload` WebSocket, the upgrade verifies the
 *  structured bearer, resolves `token_instance_id` as the scope_key, dispatches
 *  to the archive service, and acks as JSON text. Pins: happy-path chunk + a
 *  finalize that STAGES the bytes under `exports/`; auth-reject (bad bearer); and
 *  SCOPE isolation enforced by the socket's OWN verified identity. Mirrors the
 *  D-172 `/ws/upload` integration (the generic chunk frame is shared). */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeUploadChunkFrame } from '@recued/contracts';

import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createArchiveUploadService } from '../archive/archive-upload-service.js';
import { exportsDir } from '../archive/export-store.js';

const FAST_ARGON2 = { t: 1, m: 8, p: 1 };

/** Connect to `/ws/archive-upload`, send `frame` on open, resolve with the first
 *  ack message (parsed) — or `{ opened: false }` if the upgrade is rejected. */
const sendFrame = (
  port: number,
  token: string,
  frame: Uint8Array | null,
): Promise<{ opened: boolean; ack?: unknown }> =>
  new Promise((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/archive-upload?token=${encodeURIComponent(token)}`,
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

describe('M4b.1 — archive /ws/archive-upload binary socket', () => {
  let server: RunningServer | undefined;
  let db: Database.Database;
  let dir: string;
  let tid: string;
  let bearer: string;
  let service: ReturnType<typeof createArchiveUploadService>;
  const SCOPE = 'instance_owner';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'arx-upload-ws-'));
    db = new Database(':memory:');
    // No BlobStore / file collection — the archive service stages to a path.
    service = createArchiveUploadService({
      db,
      uploadsRoot: join(dir, 'upload_blobs'),
      dataPath: dir,
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
      archiveUploadDeps: { service },
    });
    server!.wsServer.maxInstances = 0;
  });

  afterAll(async () => {
    await server?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a valid bearer + a chunk frame over the wire acks ok, and finalize stages the bytes', async () => {
    const body = Buffer.from('RECUED-ARCHIVE ciphertext over the real socket');
    const create = await service.create({
      scope_key: SCOPE,
      filename: 'backup.recued.archive',
      declared_size: body.length,
    });
    expect(create.status).toBe('created');
    if (create.status !== 'created') throw new Error('unreachable');

    const frame = encodeUploadChunkFrame({ req_id: 'r1', upload_id: create.upload_id, offset: 0 }, body);
    const { opened, ack } = await sendFrame(server!.port, `${tid}.${bearer}`, frame);
    expect(opened).toBe(true);
    expect(ack).toMatchObject({ type: 'upload_ack', req_id: 'r1', ok: true, offset: body.length, complete: true });

    // The bytes really landed — finalize STAGES them under exports/ (raw).
    const fin = await service.finalize({ scope_key: SCOPE, upload_id: create.upload_id });
    expect(fin.status).toBe('finalized');
    if (fin.status !== 'finalized') throw new Error('unreachable');
    const onDisk = readFileSync(join(exportsDir(dir), fin.staged_name));
    expect(onDisk.equals(body)).toBe(true);
  });

  it('a bad bearer is rejected at upgrade (no socket)', async () => {
    const { opened } = await sendFrame(server!.port, 'not-a-valid-structured-bearer', null);
    expect(opened).toBe(false);
  });

  it('a chunk frame for an upload owned by ANOTHER scope acks forbidden (socket identity wins)', async () => {
    const body = Buffer.from('not yours');
    const create = await service.create({
      scope_key: 'other_instance',
      filename: 'other.recued.archive',
      declared_size: body.length,
    });
    if (create.status !== 'created') throw new Error('unreachable');
    const frame = encodeUploadChunkFrame({ req_id: 'r2', upload_id: create.upload_id, offset: 0 }, body);
    const { opened, ack } = await sendFrame(server!.port, `${tid}.${bearer}`, frame);
    expect(opened).toBe(true);
    expect(ack).toMatchObject({ type: 'upload_ack', req_id: 'r2', ok: false, reason: 'forbidden' });
  });
});
