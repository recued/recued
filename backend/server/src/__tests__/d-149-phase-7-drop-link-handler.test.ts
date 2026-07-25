/** D-149 P7 § A.5.4 — drop_link GET + POST integration tests.
 *
 *  Covers:
 *    - Token-less GET returns 401.
 *    - Authorized GET renders the upload form HTML with security headers
 *      (CSP / no-store / X-Frame-Options DENY / Referrer-Policy
 *      no-referrer / X-Content-Type-Options nosniff).
 *    - User-only fields (contact_scoping / auto_attach_to_project_id) ABSENT
 *      from rendered HTML (no-leak invariant).
 *    - POST with valid multipart upload persists a metadata row + writes
 *      the blob to the shared CAS BlobStore.
 *    - PII columns sub_dek-encrypted (round-trip via drop-pii open helper).
 *    - POST rejects stale / missing form_nonce.
 *    - POST rejects mismatched Origin.
 *    - POST rejects size_cap_bytes overflow with 413 + tags row
 *      `rejected_size`.
 *    - POST rejects magic-byte / reported-MIME mismatch with 415 + tags
 *      row `rejected_mime`.
 *    - POST rejects per-day cap exceeded with 429.
 *    - POST returns 405 for non-POST methods.
 *    - Cloud-traversal negative: blob bytes write to user's filesystem,
 *      not the cloud (§ Must Hold I-7).
 */

import Database from 'better-sqlite3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DropLinkConfig } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionDropBlobStore } from '../storage/reception-drop-store.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import {
  computeBearerHmac,
  deriveReceptionPepper,
} from '../ports/reception/server-secret-pepper.js';
import { createInMemoryDropLinkNonceStore } from '../ports/reception/handlers/drop-link.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  deriveDropBlobPiiKeyFromSubDek,
  openDropBlobPiiField,
} from '../ports/reception/drop-pii.js';
import type { AuditLogStore } from '@recued/storage';

const NOW = 1_700_000_000_000;
const SUB_DEK = new Uint8Array(32).fill(0x6e);
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xa1));
const DAY = 24 * 60 * 60 * 1000;
const PDF_MAGIC = Buffer.from('%PDF-1.7\n');

const fakeAudit = (): AuditLogStore & { calls: Array<unknown> } => {
  const calls: Array<unknown> = [];
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
  } as unknown as AuditLogStore & { calls: Array<unknown> };
};

let dropBlobsRoot: string;
beforeEach(() => {
  dropBlobsRoot = mkdtempSync(join(tmpdir(), 'd149-p7-handler-'));
});
afterEach(() => {
  rmSync(dropBlobsRoot, { recursive: true, force: true });
});

const buildEnv = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const blob = createReceptionDropBlobStore(db);
  const casBlobs = createBlobStore(join(dropBlobsRoot, 'cas'));
  const nonce = createInMemoryDropLinkNonceStore();
  return { db, store, cache, limiter, blob, casBlobs, nonce };
};

const goodConfig: DropLinkConfig = {
  display_name: 'Mary',
  instructions: 'Send me your contract.',
  success_message: 'Got it.',
  submit_button_label: 'Upload',
  link_kind: 'repeated',
  contact_scoping: {
    contact_id: 'c_super_secret_internal',
    require_contact_email_match: true,
  },
  size_cap_bytes: 1024,
  allowed_mime_types: ['application/pdf'],
  expiry_days: 7,
  max_uploads_per_endpoint_per_day: 5,
  required_visitor_fields: {
    name: 'optional',
    email: 'optional',
    description: 'optional',
  },
  on_upload: {
    create_data_file_entity: true,
    auto_attach_to_contact: false,
    auto_attach_to_project_id: 'proj_internal_secret',
  },
};

const insertEndpoint = (
  env: ReturnType<typeof buildEnv>,
  bearer: string,
  config: DropLinkConfig = goodConfig,
) => {
  const endpoint_id = 'ep-drop-1';
  env.store.create({
    endpoint_id,
    kind: 'drop_link',
    packet_declaration: {
      packet_kind: 'drop_link_packet',
      source_query_ref: {
        kind: 'reception_drop_config',
        drop_config_id: 'drop_p7_handler',
      },
    },
    bearer_secret_hmac: computeBearerHmac(bearer, PEPPER),
    created_at: NOW - DAY,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: NOW - DAY,
    metadata: config as unknown as Record<string, unknown>,
  });
  env.store.enable(endpoint_id, NOW);
  return endpoint_id;
};

const fakeReq = (
  method: string,
  url: string,
  body?: Buffer | string,
  headers?: Record<string, string>,
): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.7' });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  Object.assign(req.headers, headers ?? {});
  if (body !== undefined) {
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    setImmediate(() => {
      req.emit('data', buf);
      req.emit('end');
    });
  }
  return req;
};

const fakeRes = () => {
  const bodyChunks: Array<string | Buffer> = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    end(body?: string | Buffer) {
      if (body !== undefined) bodyChunks.push(body);
    },
    write(body: string | Buffer) {
      bodyChunks.push(body);
    },
    get body(): string {
      return bodyChunks
        .map((c) => (typeof c === 'string' ? c : c.toString('utf8')))
        .join('');
    },
    get status(): number {
      return res.statusCode;
    },
  } as unknown as ServerResponse & { status: number; body: string };
  return res;
};

const buildHandler = (env: ReturnType<typeof buildEnv>, audit?: AuditLogStore) =>
  createReceptionPortHandler({
    getStore: () => env.store,
    getCache: () => env.cache,
    getRateLimiter: () => env.limiter,
    getPepper: () => PEPPER,
    now: () => NOW,
    getDropBlobStore: () => env.blob,
    getBlobStore: () => env.casBlobs,
    getDropLinkNonceStore: () => env.nonce,
    getDropBlobPiiKey: () => deriveDropBlobPiiKeyFromSubDek(SUB_DEK),
    getDropBlobsRoot: () => dropBlobsRoot,
    auditLog: audit ?? fakeAudit(),
  });

// Build a synthetic multipart/form-data body. Closed shape: text parts
// keyed in `text` + a single file part keyed `blob` with raw bytes.
const buildMultipart = (input: {
  boundary: string;
  text: Record<string, string>;
  blob: { filename: string; content_type: string; bytes: Buffer };
}): Buffer => {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(input.text)) {
    parts.push(
      Buffer.from(
        `--${input.boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${input.boundary}\r\nContent-Disposition: form-data; name="blob"; filename="${input.blob.filename}"\r\nContent-Type: ${input.blob.content_type}\r\n\r\n`,
      'utf8',
    ),
  );
  parts.push(input.blob.bytes);
  parts.push(Buffer.from(`\r\n--${input.boundary}--\r\n`, 'utf8'));
  return Buffer.concat(parts);
};

// ────────────────────────────────────────────────────────────────
// GET tests
// ────────────────────────────────────────────────────────────────

describe('D-149 P7 § A.5.4 — GET /reception/drop/<id>', () => {
  it('returns 401 when no token is supplied', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/drop/ep-drop-1'), res);
    expect(res.status).toBe(401);
  });

  it('renders the upload form HTML with security headers when token is valid', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/drop/ep-drop-1?t=goodbearer'), res);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<form');
    expect(res.body).toContain('multipart/form-data');
    expect(res.body).toContain('name="blob"');
    expect(res.body).toContain('form_nonce');
    const get = (k: string) =>
      typeof res.getHeader(k) === 'string' ? (res.getHeader(k) as string) : '';
    expect(get('content-type')).toContain('text/html');
    expect(get('cache-control')).toContain('no-store');
    expect(get('x-frame-options').toUpperCase()).toBe('DENY');
    expect(get('referrer-policy')).toBe('no-referrer');
    expect(get('x-content-type-options')).toBe('nosniff');
  });

  it('omits user-only metadata from the rendered HTML (no-leak)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/drop/ep-drop-1?t=goodbearer'), res);
    expect(res.body).not.toContain('c_super_secret_internal');
    expect(res.body).not.toContain('proj_internal_secret');
    expect(res.body).not.toContain('recipe_internal_scan');
  });

  it("D-172 5c — per-render nonce'd CSP header + SRI uploader script (no <meta> CSP; JS-free form stays)", async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(fakeReq('GET', '/reception/drop/ep-drop-1?t=goodbearer'), res);
    expect(res.status).toBe(200);

    // CSP rides the HTTP RESPONSE HEADER (nonces are spotty in <meta>); the page
    // no longer carries a <meta http-equiv> CSP.
    const csp =
      typeof res.getHeader('content-security-policy') === 'string'
        ? (res.getHeader('content-security-policy') as string)
        : '';
    expect(csp).not.toBe('');
    expect(res.body).not.toContain('http-equiv');

    // script-src is a per-render nonce (strictly stronger than 'self', not 'none').
    const m = /script-src 'nonce-([^']+)'/.exec(csp);
    expect(m).not.toBeNull();
    const nonce = m![1]!;
    // The rest of the strict policy is intact (rev-4 incl. object-src 'none').
    for (const directive of [
      "default-src 'self'",
      "style-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ]) {
      expect(csp).toContain(directive);
    }

    // Exactly ONE uploader <script>, carrying THE SAME nonce + an SRI + the
    // content-addressed (cache-bustable) src.
    expect(res.body).toContain(`<script nonce="${nonce}"`);
    expect(res.body).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
    expect(res.body).toContain('/reception/_static/drop-uploader.js?v=');
    expect((res.body.match(/<script /g) ?? []).length).toBe(1);
    // SRI on a SAME-ORIGIN script must NOT be a CORS fetch.
    expect(res.body).not.toContain('crossorigin');

    // The CSP nonce is DISTINCT from the single-use form_nonce (don't conflate).
    const formNonce = /name="form_nonce" value="([^"]+)"/.exec(res.body)?.[1] ?? '';
    expect(formNonce).not.toBe('');
    expect(formNonce).not.toBe(nonce);

    // The JS-free single-POST <form> stays as the no-JS fallback.
    expect(res.body).toContain('enctype="multipart/form-data"');
  });
});

// ────────────────────────────────────────────────────────────────
// POST tests
// ────────────────────────────────────────────────────────────────

describe('D-149 P7 § A.5.4 — POST /reception/drop/<id>', () => {
  const issueNonce = (env: ReturnType<typeof buildEnv>) =>
    env.nonce.issue('ep-drop-1', NOW);

  it('returns 405 for non-POST methods', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const res = fakeRes();
    await handler(
      fakeReq('DELETE', '/reception/drop/ep-drop-1?t=goodbearer'),
      res,
    );
    expect(res.status).toBe(405);
  });

  it('rejects POST with mismatched Origin (403)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    const body = buildMultipart({
      boundary,
      text: { form_nonce: issueNonce(env) },
      blob: {
        filename: 'report.pdf',
        content_type: 'application/pdf',
        bytes: PDF_MAGIC,
      },
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://evil.example',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(403);
  });

  it('#4 race-batch — rejects a blob-FIRST POST before the CAS write (no orphan, 400)', async () => {
    // A crafted POST that streams the blob part BEFORE form_nonce must be
    // rejected in onFilePart (nonce-before-blob), so a bad/absent nonce can
    // no longer leave an orphaned CAS blob. No blob row persists.
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    const nonce = issueNonce(env);
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="blob"; filename="x.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        'utf8',
      ),
      PDF_MAGIC,
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="form_nonce"\r\n\r\n${nonce}\r\n--${boundary}--\r\n`,
        'utf8',
      ),
    ]);
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(400);
    expect(env.blob.listPendingForEndpoint('ep-drop-1')).toHaveLength(0);
  });

  it('accepts a valid upload + persists metadata + writes the blob to disk', async () => {
    const env = buildEnv();
    const audit = fakeAudit();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env, audit);
    const boundary = '----test-bound';
    const nonce = issueNonce(env);
    const body = buildMultipart({
      boundary,
      text: {
        form_nonce: nonce,
        visitor_name: 'Mary',
        visitor_email: 'visitor@example.com',
        visitor_description: 'Contract',
      },
      blob: {
        filename: 'contract.pdf',
        content_type: 'application/pdf',
        bytes: PDF_MAGIC,
      },
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain('Upload received');
    // Metadata row persists with the closed-list outcome.
    const rows = env.blob.listPendingForEndpoint('ep-drop-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mime_type_reported).toBe('application/pdf');
    expect(rows[0]!.mime_type_detected).toBe('application/pdf');
    expect(rows[0]!.size_bytes).toBe(PDF_MAGIC.length);
    expect(rows[0]!.storage_path).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.storage_path).not.toMatch(/[\\/]/);
    const stored = await env.casBlobs.get(rows[0]!.storage_path);
    expect(stored).not.toBeNull();
    expect(Buffer.compare(stored!, PDF_MAGIC)).toBe(0);
    // PII columns round-trip via AAD-bound key.
    const key = deriveDropBlobPiiKeyFromSubDek(SUB_DEK);
    expect(
      await openDropBlobPiiField({
        key,
        endpoint_id: 'ep-drop-1',
        blob_id: rows[0]!.blob_id,
        field: 'visitor_email',
        ciphertext: rows[0]!.visitor_email_encrypted,
      }),
    ).toBe('visitor@example.com');
    expect(
      await openDropBlobPiiField({
        key,
        endpoint_id: 'ep-drop-1',
        blob_id: rows[0]!.blob_id,
        field: 'visitor_name',
        ciphertext: rows[0]!.visitor_name_encrypted,
      }),
    ).toBe('Mary');
    // Audit emit.
    expect(audit.calls.length).toBe(1);
    expect((audit.calls[0] as { action: string }).action).toBe('drop_blob.received');
  });

  it('rejects stale / missing form_nonce', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    const body = buildMultipart({
      boundary,
      text: { form_nonce: 'never-issued' },
      blob: {
        filename: 'report.pdf',
        content_type: 'application/pdf',
        bytes: PDF_MAGIC,
      },
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(400);
    expect(res.body).toContain('stale');
  });

  it('rejects size_cap_bytes overflow with 413', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    const oversize = Buffer.alloc(2048, 0x41); // 2KB; cap is 1KB
    const body = buildMultipart({
      boundary,
      text: { form_nonce: issueNonce(env) },
      blob: {
        filename: 'big.pdf',
        content_type: 'application/pdf',
        bytes: Buffer.concat([PDF_MAGIC, oversize]),
      },
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(413);
  });

  it('rejects magic-byte / reported-MIME mismatch with 415', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    // Visitor reports application/pdf but bytes are a PE executable
    // (MZ header). The substrate must detect the mismatch + 415.
    const exeMagic = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const body = buildMultipart({
      boundary,
      text: { form_nonce: issueNonce(env) },
      blob: {
        filename: 'disguised.pdf',
        content_type: 'application/pdf',
        bytes: exeMagic,
      },
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(415);
    // Row persists with rejected_mime so the abuse inbox can review it.
    const persisted = env.blob.listPendingForEndpoint('ep-drop-1');
    expect(persisted).toHaveLength(0);
  });

  it('rejects MIME reported outside the per-config allowlist with 400', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    // PNG magic with PNG reported — but the per-config allowlist is
    // PDF-only, so reported MIME must be rejected at the validator.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const body = buildMultipart({
      boundary,
      text: { form_nonce: issueNonce(env) },
      blob: {
        filename: 'avatar.png',
        content_type: 'image/png',
        bytes: png,
      },
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(400);
  });

  it('rejects per-day cap exceeded with 429', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...goodConfig,
      max_uploads_per_endpoint_per_day: 1,
    });
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    // First upload — accepted.
    const body1 = buildMultipart({
      boundary,
      text: { form_nonce: issueNonce(env) },
      blob: {
        filename: 'a.pdf',
        content_type: 'application/pdf',
        bytes: PDF_MAGIC,
      },
    });
    const res1 = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body1, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res1,
    );
    expect(res1.status).toBe(200);
    // Second upload — over per-day cap.
    const body2 = buildMultipart({
      boundary,
      text: { form_nonce: issueNonce(env) },
      blob: {
        filename: 'b.pdf',
        content_type: 'application/pdf',
        bytes: PDF_MAGIC,
      },
    });
    const res2 = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body2, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res2,
    );
    expect(res2.status).toBe(429);
  });
});

// ────────────────────────────────────────────────────────────────
// Codex review folds (2026-05-13) — P1 ratchet tests
// ────────────────────────────────────────────────────────────────

describe('D-149 P7 § A.5.4 — Codex P1 #1 ratchet (text-field cap during read)', () => {
  it('rejects an oversized visitor_description streamed without a closing delimiter', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    // Build a payload where visitor_description carries 32 KB of `x`
    // (more than the 16 KB substrate cap). The cap is enforced
    // synchronously inside parseMultipartUpload's inner read loop;
    // without the fold the parser would buffer all 32 KB before
    // failing.
    const oversize = 'x'.repeat(32 * 1024);
    const nonce = env.nonce.issue('ep-drop-1', NOW);
    const body = buildMultipart({
      boundary,
      text: {
        form_nonce: nonce,
        visitor_description: oversize,
      },
      blob: {
        filename: 'doc.pdf',
        content_type: 'application/pdf',
        bytes: PDF_MAGIC,
      },
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(413);
  });
});

describe('D-149 P7 § A.5.4 — Codex P1 #2 ratchet (no orphan blob on bad nonce)', () => {
  it('rejects a bad nonce + cleans the streamed blob from disk', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    // Bypass the substrate nonce store entirely — visitor supplies a
    // never-issued nonce. The pre-consume happens in onTextField;
    // the substrate must abort + unlink any blob bytes already on
    // disk so a malicious reordered POST can't fill the partition.
    const body = buildMultipart({
      boundary,
      text: { form_nonce: 'never-issued' },
      blob: {
        filename: 'doc.pdf',
        content_type: 'application/pdf',
        bytes: PDF_MAGIC,
      },
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(400);
    // The drop_blobs scratch subtree must not contain any orphaned
    // scratch file — only `_tmp` and the local CAS root are permitted.
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const dropBlobsListing = readdirSync(dropBlobsRoot).filter(
      (e: string) => e !== '_tmp' && e !== 'cas',
    );
    expect(dropBlobsListing).toEqual([]);
  });
});

describe('D-149 P7 § A.5.4 — Codex P1 #3 ratchet (one_time link revoke)', () => {
  it('revokes the endpoint after a successful one_time upload', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...goodConfig,
      link_kind: 'one_time',
    });
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    const body = buildMultipart({
      boundary,
      text: { form_nonce: env.nonce.issue('ep-drop-1', NOW) },
      blob: {
        filename: 'final.pdf',
        content_type: 'application/pdf',
        bytes: PDF_MAGIC,
      },
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(200);
    // The endpoint row must be revoked.
    const row = env.store.findById('ep-drop-1');
    expect(row?.revoked_at).not.toBeNull();
    expect(row?.revocation_reason).toBe('one_time_drop_consumed');
  });

  it('does NOT revoke for link_kind=repeated', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer'); // default `'repeated'`
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    const body = buildMultipart({
      boundary,
      text: { form_nonce: env.nonce.issue('ep-drop-1', NOW) },
      blob: {
        filename: 'final.pdf',
        content_type: 'application/pdf',
        bytes: PDF_MAGIC,
      },
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(200);
    const row = env.store.findById('ep-drop-1');
    expect(row?.revoked_at).toBeNull();
    // Contrast guard: the dispatcher populated the cache during the
    // request and (correctly) did NOT invalidate it — `repeated` links
    // stay live, so the cache entry must survive.
    expect(env.cache.get('ep-drop-1', NOW)).not.toBeNull();
  });

  // § Must Hold I-5 regression — the in-handler one_time revoke bypasses
  // the rpc `endpoint.revoke` → `reception.endpoint_changed` bus path, so
  // it must invalidate the registry cache directly. Without that, the
  // dispatcher keeps serving the stale enabled entry (and accepts a
  // second upload) for up to REGISTRY_CACHE_STALENESS_MS — defeating the
  // `one_time` guarantee within the staleness window.
  it('invalidates the registry cache on a one_time consume so the stale entry cannot serve a second upload', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer', {
      ...goodConfig,
      link_kind: 'one_time',
    });
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    const body = buildMultipart({
      boundary,
      text: { form_nonce: env.nonce.issue('ep-drop-1', NOW) },
      blob: {
        filename: 'final.pdf',
        content_type: 'application/pdf',
        bytes: PDF_MAGIC,
      },
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(200);
    // The dispatcher put the row in cache during the POST; the one_time
    // revoke must then drop it.
    expect(env.cache.get('ep-drop-1', NOW)).toBeNull();

    // A follow-up GET now misses the cache, re-reads the revoked store
    // row, and refuses a fresh upload form (no second blob can land).
    const res2 = fakeRes();
    await handler(
      fakeReq('GET', '/reception/drop/ep-drop-1?t=goodbearer', undefined, {
        host: 'mary.recued.cloud',
      }),
      res2,
    );
    expect(res2.status).toBeGreaterThanOrEqual(400);
    expect(res2.body).not.toContain('name="blob"');
  });
});

// ────────────────────────────────────────────────────────────────
// Cloud-traversal negative (§ Must Hold I-7)
// ────────────────────────────────────────────────────────────────

describe('D-149 P7 § Must Hold I-7 — cloud-traversal negative', () => {
  it('blob bytes land on the user filesystem only (never cloud paths)', async () => {
    const env = buildEnv();
    insertEndpoint(env, 'goodbearer');
    const handler = buildHandler(env);
    const boundary = '----test-bound';
    const nonce = env.nonce.issue('ep-drop-1', NOW);
    const body = buildMultipart({
      boundary,
      text: { form_nonce: nonce },
      blob: {
        filename: 'doc.pdf',
        content_type: 'application/pdf',
        bytes: Buffer.concat([PDF_MAGIC, Buffer.from('payload')]),
      },
    });
    const res = fakeRes();
    await handler(
      fakeReq('POST', '/reception/drop/ep-drop-1?t=goodbearer', body, {
        host: 'mary.recued.cloud',
        origin: 'https://mary.recued.cloud',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }),
      res,
    );
    expect(res.status).toBe(200);
    // Persisted row carries the CAS hash as storage_path.
    const rows = env.blob.listPendingForEndpoint('ep-drop-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.storage_path).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.storage_path).not.toMatch(/[\\/]/);
    expect(await env.casBlobs.get(rows[0]!.storage_path)).not.toBeNull();
  });
});
