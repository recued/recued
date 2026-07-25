/** D-172 step 5a — reception resumable-upload HTTP endpoints (server-only).
 *
 *  Drives the RECEPTION consumer of the shared chunk-core end-to-end headless
 *  (the design's stated P1 goal), over RAW HTTP through the real reception
 *  dispatcher (`createReceptionPortHandler`) — bearer verify, the
 *  `…/uploads` sub-routing, and the deliberate bypass of the link-style request
 *  limiter for the chunk data plane all in the loop. Mirrors the webclient
 *  `d-172-webclient-upload-ws.test.ts` worked example, but the transport is HTTP
 *  (create = JSON POST, chunk = raw-body POST + `Upload-Offset`, probe = GET,
 *  finalize = JSON POST, delete = DELETE) instead of the binary WS frame.
 *
 *  Pins:
 *    - create → chunk → finalize lands a `pending` `reception_drop_blob_metadata`
 *      row (drain-ready — the existing D-172 P3 drain materializes
 *      `data.file.received` from a row of this exact shape) + the bytes in the
 *      CAS at `content_hash`.
 *    - resume via the GET probe reports the persisted offset.
 *    - the chunk data plane bypasses the drop_link 5/hr per-IP limiter (a
 *      >5-chunk upload completes — proving the routing decision that lets a
 *      chunked GiB upload through).
 *    - abuse-cap rejections: daily cap (429), per-create size cap (413), stale
 *      form-nonce (400).
 *    - the finalize magic-byte/MIME cross-check rejects a disguised file (415)
 *      while still persisting the row for the Abuse Inbox.
 *    - scope isolation: a wrong-endpoint probe is a non-leaking 404.
 *    - degrade: with no upload service wired the `…/uploads` sub-tree 404s.
 *    - service-level: the concurrent-session cap, the TTL sweeper, and the
 *      finalize idempotency guard. */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DropLinkConfig } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionDropBlobStore } from '../storage/reception-drop-store.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import {
  createReceptionPortHandler,
  type ReceptionPortHandlerDeps,
} from '../ports/reception/handler.js';
import {
  computeBearerHmac,
  deriveReceptionPepper,
} from '../ports/reception/server-secret-pepper.js';
import { createInMemoryDropLinkNonceStore } from '../ports/reception/handlers/drop-link.js';
import { createBlobStore } from '../storage/blob-store.js';
import { deriveDropBlobPiiKeyFromSubDek } from '../ports/reception/drop-pii.js';
import {
  createReceptionUploadService,
  type ReceptionUploadService,
} from '../upload/reception-upload-service.js';

const SUB_DEK = new Uint8Array(32).fill(0x6e);
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xa1));
const HOST = 'drop.example.com';
const ORIGIN = `https://${HOST}`;
const BEARER = 'goodbearer';
const EP = 'ep-drop-1';
const TTL = 60_000;
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

let root: string;
let clock: number;
let idc: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'd172-p5a-'));
  clock = 1_700_000_000_000;
  idc = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const fakeAudit = (): AuditLogStore & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    logActivity: async (input: unknown) => {
      calls.push(input);
      return undefined;
    },
    listActivity: async () => [],
    listAgentAccess: async () => [],
    listProvenanceLinks: async () => [],
    timeline: async () => [],
    bumpInsightSnapshotIfDifferent: async () => null,
    queryRecipeInsight: async () => null,
    calls,
  } as unknown as AuditLogStore & { calls: unknown[] };
};

const baseConfig = (over: Partial<DropLinkConfig> = {}): DropLinkConfig => ({
  display_name: 'Mary',
  success_message: 'Got it.',
  submit_button_label: 'Upload',
  link_kind: 'repeated',
  size_cap_bytes: 1024,
  allowed_mime_types: ['application/pdf'],
  expiry_days: 7,
  max_uploads_per_endpoint_per_day: 5,
  required_visitor_fields: { name: 'optional', email: 'optional', description: 'optional' },
  on_upload: {
    create_data_file_entity: true,
    auto_attach_to_contact: false,
  },
  ...over,
});

const buildEnv = (opts: { withService?: boolean; minChunk?: number } = {}) => {
  const withService = opts.withService ?? true;
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const dropStore = createReceptionDropBlobStore(db);
  const casBlobs = createBlobStore(join(root, 'cas'));
  const nonce = createInMemoryDropLinkNonceStore();
  const audit = fakeAudit();
  const uploadService: ReceptionUploadService | undefined = withService
    ? createReceptionUploadService({
        db,
        blobs: casBlobs,
        uploadsRoot: join(root, 'upload_blobs'),
        dropBlobStore: dropStore,
        getStore: () => store,
        getDropLinkNonceStore: () => nonce,
        getDropBlobPiiKey: () => deriveDropBlobPiiKeyFromSubDek(SUB_DEK),
        auditLog: audit,
        now: () => clock,
        mintUploadId: () => `up_${++idc}`,
        ttlMs: TTL,
        // Tiny floor so the small-chunk fixtures stay fast; a dedicated test
        // sets a realistic floor to exercise the per-upload fsync-work bound.
        minChunkBytes: opts.minChunk ?? 4,
        invalidateRegistryCache: (id) => cache.invalidate(id),
      })
    : undefined;
  return { db, store, cache, limiter, dropStore, casBlobs, nonce, audit, uploadService };
};

const insertEndpoint = (
  env: ReturnType<typeof buildEnv>,
  endpoint_id: string,
  bearer: string,
  config: DropLinkConfig = baseConfig(),
) => {
  env.store.create({
    endpoint_id,
    kind: 'drop_link',
    packet_declaration: {
      packet_kind: 'drop_link_packet',
      source_query_ref: { kind: 'reception_drop_config', drop_config_id: `cfg_${endpoint_id}` },
    },
    bearer_secret_hmac: computeBearerHmac(bearer, PEPPER),
    created_at: clock - 86_400_000,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: clock - 86_400_000,
    metadata: config as unknown as Record<string, unknown>,
  });
  env.store.enable(endpoint_id, clock);
};

const buildHandler = (env: ReturnType<typeof buildEnv>) => {
  const deps: ReceptionPortHandlerDeps = {
    getStore: () => env.store,
    getCache: () => env.cache,
    getRateLimiter: () => env.limiter,
    getPepper: () => PEPPER,
    now: () => clock,
    ...(env.uploadService ? { getReceptionUploadService: () => env.uploadService! } : {}),
  };
  return createReceptionPortHandler(deps);
};

const fakeReq = (
  method: string,
  url: string,
  body?: Buffer | string,
  headers: Record<string, string> = {},
): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.7' });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  Object.assign(req.headers, { host: HOST, origin: ORIGIN, ...headers });
  const buf = body === undefined ? Buffer.alloc(0) : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  setImmediate(() => {
    if (buf.length > 0) req.emit('data', buf);
    req.emit('end');
  });
  return req;
};

const fakeRes = () => {
  const chunks: Array<string | Buffer> = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    end(b?: string | Buffer) {
      if (b !== undefined) chunks.push(b);
    },
    write(b: string | Buffer) {
      chunks.push(b);
    },
    get body(): string {
      return chunks.map((c) => (typeof c === 'string' ? c : c.toString('utf8'))).join('');
    },
    get json(): any {
      return JSON.parse(res.body);
    },
    get status(): number {
      return res.statusCode;
    },
  } as unknown as ServerResponse & { status: number; body: string; json: any };
  return res;
};

const u = (path = '', ep = EP, bearer = BEARER): string =>
  `/reception/drop/${ep}/uploads${path}?t=${encodeURIComponent(bearer)}`;

/** POST create — returns the response. */
const create = async (
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  body: Record<string, unknown>,
  ep = EP,
  bearer = BEARER,
) => {
  const res = fakeRes();
  await handler(fakeReq('POST', u('', ep, bearer), JSON.stringify(body), { 'content-type': 'application/json' }), res);
  return res;
};

/** POST a chunk at `offset`. */
const chunk = async (
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  upload_id: string,
  offset: number,
  slice: Buffer,
  extra: Record<string, string> = {},
  ep = EP,
  bearer = BEARER,
) => {
  const res = fakeRes();
  await handler(
    fakeReq('POST', u(`/${upload_id}`, ep, bearer), slice, { 'upload-offset': String(offset), ...extra }),
    res,
  );
  return res;
};

describe('D-172 P5a — dispatch happy path + resume', () => {
  it('create → chunk → finalize lands a pending drop row + the bytes in the CAS', async () => {
    const env = buildEnv();
    insertEndpoint(env, EP, BEARER);
    const handler = buildHandler(env);
    const body = Buffer.from('%PDF-1.7\nhello resumable reception upload');
    const nonce = env.nonce.issue(EP, clock);

    const cRes = await create(handler, {
      filename: 'note.pdf',
      declared_size: body.length,
      mime_reported: 'application/pdf',
      form_nonce: nonce,
    });
    expect(cRes.status).toBe(201);
    const upload_id = cRes.json.upload_id as string;
    expect(upload_id).toBe('up_1');

    const chRes = await chunk(handler, upload_id, 0, body, { 'upload-checksum': sha(body) });
    expect(chRes.status).toBe(200);
    expect(chRes.json).toEqual({ offset: body.length, complete: true });

    const fRes = fakeRes();
    await handler(
      fakeReq('POST', u(`/${upload_id}/finalize`), JSON.stringify({ visitor_name: 'Bob' })),
      fRes,
    );
    expect(fRes.status).toBe(200);
    expect(fRes.json.status).toBe('accepted');
    const blob_id = fRes.json.blob_id as string;

    // A drain-ready `pending` row (the existing D-172 P3 drop drain materializes
    // `data.file.received` from a row of this exact shape).
    const row = env.dropStore.findById(blob_id);
    expect(row).not.toBeNull();
    expect(row!.processing_outcome).toBe('pending');
    expect(row!.content_hash).toBe(sha(body));
    expect(row!.storage_path).toBe(sha(body));
    expect(row!.filename_sanitized).toBe('note.pdf');
    expect(row!.mime_type_detected).toBe('application/pdf');
    // The bytes are really in the CAS, readable back by hash.
    const back = await env.casBlobs.get(sha(body));
    expect(Buffer.from(back!).equals(body)).toBe(true);
  });

  it('resumes from the persisted offset via the GET probe between chunks', async () => {
    const env = buildEnv();
    insertEndpoint(env, EP, BEARER);
    const handler = buildHandler(env);
    const body = Buffer.from('%PDF-1.7\n' + 'A'.repeat(200) + 'B'.repeat(200));
    const nonce = env.nonce.issue(EP, clock);
    const upload_id = (await create(handler, {
      filename: 'doc.pdf',
      declared_size: body.length,
      mime_reported: 'application/pdf',
      form_nonce: nonce,
    })).json.upload_id as string;

    const a1 = await chunk(handler, upload_id, 0, body.subarray(0, 150));
    expect(a1.json).toEqual({ offset: 150, complete: false });

    // Resume probe — reports the persisted offset for the SAME file identity.
    const pRes = fakeRes();
    await handler(
      fakeReq('GET', `/reception/drop/${EP}/uploads/${upload_id}?t=${BEARER}&filename=${encodeURIComponent('doc.pdf')}&declared_size=${body.length}`),
      pRes,
    );
    expect(pRes.status).toBe(200);
    expect(pRes.json).toEqual({ offset: 150, complete: false });

    const a2 = await chunk(handler, upload_id, 150, body.subarray(150));
    expect(a2.json).toEqual({ offset: body.length, complete: true });

    const fRes = fakeRes();
    await handler(fakeReq('POST', u(`/${upload_id}/finalize`), '{}'), fRes);
    expect(fRes.json.status).toBe('accepted');
  });
});

describe('D-172 P5a — chunk data plane bypasses the link request limiter', () => {
  it('a >5-chunk upload completes (chunks never consume the drop_link 5/hr per-IP bucket)', async () => {
    const env = buildEnv();
    insertEndpoint(env, EP, BEARER);
    const handler = buildHandler(env);
    // 6 chunks of 10 bytes — if chunks went through the per-IP pre-verify, the
    // 5th chunk (the 6th drop_link request incl. create) would 429 on the
    // 5/hr per-endpoint-kind bucket. They bypass it, so all 6 succeed.
    const body = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(60 - 9, 0x41)]);
    const nonce = env.nonce.issue(EP, clock);
    const upload_id = (await create(handler, {
      filename: 'big.pdf',
      declared_size: body.length,
      mime_reported: 'application/pdf',
      form_nonce: nonce,
    })).json.upload_id as string;

    let offset = 0;
    const step = 10;
    for (let i = 0; i < 6; i++) {
      const slice = body.subarray(offset, offset + step);
      const r = await chunk(handler, upload_id, offset, slice);
      expect(r.status).toBe(200);
      offset += slice.length;
    }
    expect(offset).toBe(body.length);
    const fRes = fakeRes();
    await handler(fakeReq('POST', u(`/${upload_id}/finalize`), '{}'), fRes);
    expect(fRes.json.status).toBe('accepted');
  });
});

describe('D-172 P5a — abuse-cap rejections at create', () => {
  it('rejects past the per-endpoint daily cap (429) — counting COMPLETED uploads', async () => {
    const env = buildEnv();
    insertEndpoint(env, EP, BEARER, baseConfig({ max_uploads_per_endpoint_per_day: 2 }));
    const handler = buildHandler(env);
    // Seed 2 completed (pending) drop rows in the window.
    for (let i = 0; i < 2; i++) {
      env.dropStore.insert({
        blob_id: `seed_${i}`,
        endpoint_id: EP,
        uploaded_at: clock,
        source_ip_hash: null,
        visitor_email_encrypted: null,
        visitor_name_encrypted: null,
        visitor_description_encrypted: null,
        filename_sanitized: 'a.pdf',
        mime_type_reported: 'application/pdf',
        mime_type_detected: 'application/pdf',
        size_bytes: 10,
        content_hash: `h${i}`,
        storage_path: `h${i}`,
        processing_outcome: 'pending',
      });
    }
    const nonce = env.nonce.issue(EP, clock);
    const res = await create(handler, {
      filename: 'x.pdf',
      declared_size: 10,
      mime_reported: 'application/pdf',
      form_nonce: nonce,
    });
    expect(res.status).toBe(429);
    expect(res.json.error.code).toBe('daily_cap');
  });

  it('rejects an over-cap declared_size at create (413) — before any upload', async () => {
    const env = buildEnv();
    insertEndpoint(env, EP, BEARER, baseConfig({ size_cap_bytes: 1024 }));
    const handler = buildHandler(env);
    const nonce = env.nonce.issue(EP, clock);
    const res = await create(handler, {
      filename: 'huge.pdf',
      declared_size: 4096,
      mime_reported: 'application/pdf',
      form_nonce: nonce,
    });
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('size_cap_exceeded');
  });

  it('rejects a stale / missing form-nonce (400)', async () => {
    const env = buildEnv();
    insertEndpoint(env, EP, BEARER);
    const handler = buildHandler(env);
    const res = await create(handler, {
      filename: 'x.pdf',
      declared_size: 10,
      mime_reported: 'application/pdf',
      form_nonce: 'never-issued',
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('invalid_nonce');
  });
});

describe('D-172 P5a — finalize magic-byte/MIME cross-check', () => {
  it('rejects a disguised file (415) but still persists the row for the Abuse Inbox', async () => {
    const env = buildEnv();
    insertEndpoint(env, EP, BEARER);
    const handler = buildHandler(env);
    // Reported application/pdf, but the bytes are plain text (no %PDF- magic).
    const body = Buffer.from('this is definitely not a pdf file at all');
    const nonce = env.nonce.issue(EP, clock);
    const upload_id = (await create(handler, {
      filename: 'fake.pdf',
      declared_size: body.length,
      mime_reported: 'application/pdf',
      form_nonce: nonce,
    })).json.upload_id as string;
    await chunk(handler, upload_id, 0, body);

    const fRes = fakeRes();
    await handler(fakeReq('POST', u(`/${upload_id}/finalize`), '{}'), fRes);
    expect(fRes.status).toBe(415);
    expect(fRes.json.error.code).toBe('rejected_mime');
    // The row IS persisted (the Abuse Inbox reads rejected outcomes).
    const row = env.dropStore.findById('drop_resumable_' + upload_id);
    expect(row!.processing_outcome).toBe('rejected_mime');
  });
});

describe('D-172 P5a — scope isolation', () => {
  it('a probe via the wrong endpoint URL is a non-leaking 404', async () => {
    const env = buildEnv();
    insertEndpoint(env, EP, BEARER);
    insertEndpoint(env, 'ep-drop-2', 'bearer2');
    const handler = buildHandler(env);
    const body = Buffer.from('%PDF-1.7\nsecret');
    const nonce = env.nonce.issue(EP, clock);
    const upload_id = (await create(handler, {
      filename: 's.pdf',
      declared_size: body.length,
      mime_reported: 'application/pdf',
      form_nonce: nonce,
    })).json.upload_id as string;

    const pRes = fakeRes();
    await handler(
      fakeReq('GET', `/reception/drop/ep-drop-2/uploads/${upload_id}?t=bearer2&filename=s.pdf&declared_size=${body.length}`),
      pRes,
    );
    expect(pRes.status).toBe(404);
    expect(pRes.json.error.code).toBe('not_found');

    // The original endpoint still resumes it.
    const ok = fakeRes();
    await handler(
      fakeReq('GET', `/reception/drop/${EP}/uploads/${upload_id}?t=${BEARER}&filename=s.pdf&declared_size=${body.length}`),
      ok,
    );
    expect(ok.status).toBe(200);
    expect(ok.json.offset).toBe(0);
  });
});

describe('D-172 P5a — degrade when no upload service is wired', () => {
  it('the …/uploads sub-tree 404s (single-POST stays the only upload path)', async () => {
    const env = buildEnv({ withService: false });
    insertEndpoint(env, EP, BEARER);
    const handler = buildHandler(env);
    const nonce = env.nonce.issue(EP, clock);
    const res = await create(handler, {
      filename: 'x.pdf',
      declared_size: 10,
      mime_reported: 'application/pdf',
      form_nonce: nonce,
    });
    expect(res.status).toBe(404);
  });
});

describe('D-172 P5a — service-level caps + sweeper + idempotency', () => {
  it('refuses create past the concurrent-session cap (too_many_sessions)', async () => {
    const env = buildEnv();
    insertEndpoint(env, EP, BEARER, baseConfig({ max_uploads_per_endpoint_per_day: 100 }));
    const svc = env.uploadService!;
    // 5 concurrent sessions allowed; the 6th is refused.
    for (let i = 0; i < 5; i++) {
      const r = await svc.create({
        endpoint_id: EP,
        filename: `f${i}.pdf`,
        declared_size: 100,
        mime_reported: 'application/pdf',
        form_nonce: env.nonce.issue(EP, clock),
      });
      expect(r.status).toBe('created');
    }
    const sixth = await svc.create({
      endpoint_id: EP,
      filename: 'f6.pdf',
      declared_size: 100,
      mime_reported: 'application/pdf',
      form_nonce: env.nonce.issue(EP, clock),
    });
    expect(sixth).toEqual({ status: 'rejected', reason: 'too_many_sessions' });
  });

  it('the TTL sweeper reaps an abandoned session', async () => {
    const env = buildEnv();
    insertEndpoint(env, EP, BEARER);
    const svc = env.uploadService!;
    const r = await svc.create({
      endpoint_id: EP,
      filename: 'a.pdf',
      declared_size: 100,
      mime_reported: 'application/pdf',
      form_nonce: env.nonce.issue(EP, clock),
    });
    expect(r.status).toBe('created');
    const upload_id = r.status === 'created' ? r.upload_id : '';

    // Still live before TTL.
    expect((await svc.sweepExpired({ now: clock + 1 })).reaped).toBe(0);
    // Past TTL → reaped; a subsequent probe is not_found.
    expect((await svc.sweepExpired({ now: clock + TTL + 1 })).reaped).toBe(1);
    expect(
      svc.probe({ endpoint_id: EP, upload_id, filename: 'a.pdf', declared_size: 100, now: clock + TTL + 2 }),
    ).toEqual({ resumable: false, reason: 'not_found' });
  });

  it('finalize is idempotent — a pre-existing row short-circuits without double-inserting', async () => {
    const env = buildEnv();
    insertEndpoint(env, EP, BEARER);
    const svc = env.uploadService!;
    const body = Buffer.from('%PDF-1.7\nidempotent');
    const r = await svc.create({
      endpoint_id: EP,
      filename: 'i.pdf',
      declared_size: body.length,
      mime_reported: 'application/pdf',
      form_nonce: env.nonce.issue(EP, clock),
    });
    const upload_id = r.status === 'created' ? r.upload_id : '';
    await svc.chunk({ endpoint_id: EP, upload_id, expected_offset: 0, bytes: body });

    // Simulate a finalize that persisted the row but crashed before the core
    // reaped the session (the deterministic blob_id is the dedup key).
    const blob_id = `drop_resumable_${upload_id}`;
    env.dropStore.insert({
      blob_id,
      endpoint_id: EP,
      uploaded_at: clock,
      source_ip_hash: null,
      visitor_email_encrypted: null,
      visitor_name_encrypted: null,
      visitor_description_encrypted: null,
      filename_sanitized: 'i.pdf',
      mime_type_reported: 'application/pdf',
      mime_type_detected: 'application/pdf',
      size_bytes: body.length,
      content_hash: sha(body),
      storage_path: sha(body),
      processing_outcome: 'pending',
    });
    const before = env.dropStore.countWithinWindow({ endpoint_id: EP, window_start_at: clock - 1, now: clock + 1 });

    const fin = await svc.finalize({ endpoint_id: EP, upload_id, visitor_fields: {} });
    expect(fin.status).toBe('finalized');
    // No second row was inserted (the guard short-circuited on the existing row).
    const after = env.dropStore.countWithinWindow({ endpoint_id: EP, window_start_at: clock - 1, now: clock + 1 });
    expect(after).toBe(before);
  });

  it('finalize retry still closes a one_time link (the short-circuit is not a revoke-skip)', async () => {
    const env = buildEnv();
    insertEndpoint(env, EP, BEARER, baseConfig({ link_kind: 'one_time' }));
    const svc = env.uploadService!;
    const body = Buffer.from('%PDF-1.7\nonce only');
    const r = await svc.create({
      endpoint_id: EP,
      filename: 'o.pdf',
      declared_size: body.length,
      mime_reported: 'application/pdf',
      form_nonce: env.nonce.issue(EP, clock),
    });
    const upload_id = r.status === 'created' ? r.upload_id : '';
    await svc.chunk({ endpoint_id: EP, upload_id, expected_offset: 0, bytes: body });

    // Simulate a first finalize that persisted the pending row but crashed
    // BEFORE the one_time revoke (the registry is still un-revoked).
    env.dropStore.insert({
      blob_id: `drop_resumable_${upload_id}`,
      endpoint_id: EP,
      uploaded_at: clock,
      source_ip_hash: null,
      visitor_email_encrypted: null,
      visitor_name_encrypted: null,
      visitor_description_encrypted: null,
      filename_sanitized: 'o.pdf',
      mime_type_reported: 'application/pdf',
      mime_type_detected: 'application/pdf',
      size_bytes: body.length,
      content_hash: sha(body),
      storage_path: sha(body),
      processing_outcome: 'pending',
    });
    expect(env.store.findById(EP)!.revoked_at).toBeNull();

    const fin = await svc.finalize({ endpoint_id: EP, upload_id, visitor_fields: {} });
    expect(fin.status).toBe('finalized');
    // The retry short-circuit re-attempted the idempotent revoke → link closed.
    expect(env.store.findById(EP)!.revoked_at).not.toBeNull();
  });
});

describe('D-172 P5a — minimum non-final chunk floor (per-upload fsync-work bound)', () => {
  it('rejects a sub-floor non-final chunk (400) but allows a small FINAL chunk', async () => {
    const env = buildEnv({ minChunk: 1024 });
    insertEndpoint(env, EP, BEARER, baseConfig({ size_cap_bytes: 1024 * 1024 }));
    const handler = buildHandler(env);
    const body = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000 - 9, 0x41)]); // 2000 bytes
    const nonce = env.nonce.issue(EP, clock);
    const upload_id = (await create(handler, {
      filename: 'b.pdf',
      declared_size: body.length,
      mime_reported: 'application/pdf',
      form_nonce: nonce,
    })).json.upload_id as string;

    // A 100-byte chunk at offset 0 is NOT final (100 ≠ 2000) and is below the
    // 1024 floor → rejected (the abuser can't force tiny per-chunk fsyncs).
    const tiny = await chunk(handler, upload_id, 0, body.subarray(0, 100));
    expect(tiny.status).toBe(400);
    expect(tiny.json.error.code).toBe('chunk_too_small');

    // A ≥ floor non-final chunk is accepted; the small remainder (final) is exempt.
    const big = await chunk(handler, upload_id, 0, body.subarray(0, 1500));
    expect(big.json).toEqual({ offset: 1500, complete: false });
    const tail = await chunk(handler, upload_id, 1500, body.subarray(1500)); // 500 bytes, final
    expect(tail.json).toEqual({ offset: body.length, complete: true });
  });
});
