import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DropLinkConfig } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createPublicEndpointRegistryStore } from '../storage/public-endpoint-registry-store.js';
import { createReceptionDropBlobStore } from '../storage/reception-drop-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { deriveReceptionPepper, computeBearerHmac } from '../ports/reception/server-secret-pepper.js';
import { createInMemoryDropLinkNonceStore } from '../ports/reception/handlers/drop-link.js';
import { deriveDropBlobPiiKeyFromSubDek } from '../ports/reception/drop-pii.js';
import { createReceptionUploadService } from '../upload/reception-upload-service.js';
import { admitDropBlob } from '../ports/reception/drop-admission.js';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xa1));
const PDF = Buffer.from('%PDF-1.7\nshared fixture bytes\n');
const config: DropLinkConfig = {
  display_name: 'Fixture', instructions: 'Upload a PDF.', success_message: 'Received.', submit_button_label: 'Upload',
  link_kind: 'repeated', size_cap_bytes: 1024, allowed_mime_types: ['application/pdf'], expiry_days: 7,
  max_uploads_per_endpoint_per_day: 5, required_visitor_fields: { name: 'optional', email: 'optional', description: 'optional' },
  on_upload: { create_data_file_entity: true, auto_attach_to_contact: false },
};
type Transport = 'single' | 'resumable';
const fixture = (overrides: Partial<DropLinkConfig> = {}, databasePath = ':memory:', trustForwardedFor = false) => {
  const root = mkdtempSync(join(tmpdir(), 'drop-admission-'));
  const db = new Database(databasePath);
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db);
  const drops = createReceptionDropBlobStore(db), nonce = createInMemoryDropLinkNonceStore();
  const cas = createBlobStore(join(root, 'cas'));
  const cache = createReceptionRegistryCache(), limiter = createReceptionRateLimiter({ db });
  const auditCalls: Array<Parameters<AuditLogStore['logActivity']>[0]> = [];
  const auditLog = { logActivity: async (input: Parameters<AuditLogStore['logActivity']>[0]) => { auditCalls.push(input); } } as AuditLogStore;
  let now = NOW, id = 0;
  registry.create({ endpoint_id: 'ep-drop', kind: 'drop_link',
    packet_declaration: { packet_kind: 'drop_link_packet', source_query_ref: { kind: 'reception_drop_config', drop_config_id: 'fixture' } },
    bearer_secret_hmac: computeBearerHmac('fixture-bearer', PEPPER), created_at: NOW - 1000,
    created_by_client_id: 'fixture', expires_at: NOW + 120_000, long_lived_acknowledged_at: null,
    metadata: { ...config, ...overrides } });
  registry.enable('ep-drop', NOW);
  const key = deriveDropBlobPiiKeyFromSubDek(new Uint8Array(32).fill(0x6e));
  const service = createReceptionUploadService({ db, blobs: cas, uploadsRoot: join(root, 'uploads'),
    dropBlobStore: drops, getStore: () => registry, getDropLinkNonceStore: () => nonce,
    getDropBlobPiiKey: () => key, auditLog, now: () => now, minChunkBytes: 1,
    invalidateRegistryCache: endpoint => cache.invalidate(endpoint) });
  const handler = createReceptionPortHandler({ getStore: () => registry, getCache: () => cache,
    trustForwardedFor,
    getRateLimiter: () => limiter, getPepper: () => PEPPER, now: () => now,
    getDropBlobStore: () => drops, getBlobStore: () => cas, getDropLinkNonceStore: () => nonce,
    getDropBlobPiiKey: () => key, getDropBlobsRoot: () => root, auditLog, getReceptionUploadService: () => service });
  const start = async (transport: Transport, request: { filename?: string; mime?: string;
    headers?: Record<string, string | undefined>; formNonce?: string } = {}) => {
    const { filename = 'report.pdf', mime = 'application/pdf' } = request;
    const index = ++id, boundary = `drop-boundary-${index}`;
    const formNonce = request.formNonce ?? nonce.issue('ep-drop', now);
    let path = '/reception/drop/ep-drop';
    let body: Buffer;
    if (transport === 'resumable') {
      const created = await service.create({ endpoint_id: 'ep-drop', filename, declared_size: PDF.length,
        mime_reported: mime, form_nonce: formNonce });
      if (created.status !== 'created') throw new Error(`Failed to create fixture: ${JSON.stringify(created)}`);
      expect(await service.chunk({ endpoint_id: 'ep-drop', upload_id: created.upload_id, expected_offset: 0, bytes: PDF })).toHaveProperty('ok', true);
      path += `/uploads/${created.upload_id}/finalize`;
      body = Buffer.from(JSON.stringify({ visitor_email: 'visitor@example.test' }));
    } else {
      body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="form_nonce"\r\n\r\n${formNonce}\r\n--${boundary}\r\nContent-Disposition: form-data; name="visitor_email"\r\n\r\nvisitor@example.test\r\n--${boundary}\r\nContent-Disposition: form-data; name="blob"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`), PDF, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    }
    const req = new IncomingMessage(new Socket());
    Object.defineProperty(req.socket, 'remoteAddress', { value: `203.0.113.${10 + index}` });
    req.method = 'POST'; req.url = `${path}?t=fixture-bearer`;
    Object.assign(req.headers, { host: 'localhost', origin: 'http://localhost',
      'content-type': transport === 'single' ? `multipart/form-data; boundary=${boundary}` : 'application/json',
      ...request.headers });
    const res = { statusCode: 200, headers: new Map<string, string>(), body: '',
      setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value); },
      getHeader(name: string) { return this.headers.get(name.toLowerCase()); },
      write(value: string | Buffer) { this.body += String(value); },
      end(value?: string | Buffer) { if (value !== undefined) this.body += String(value); } };
    const pending = handler(req, res as unknown as ServerResponse);
    await vi.waitFor(() => expect(req.listenerCount('data') > 0 || res.statusCode !== 200).toBe(true));
    return { req, res, pending, formNonce, send: () => { req.emit('data', body); req.emit('end'); return pending; } };
  };
  const change = (what: 'revoke' | 'disable' | 'rotate' | 'expire') => {
    if (what === 'revoke') registry.revoke({ endpoint_id: 'ep-drop', now, reason: 'Owner revoked' });
    if (what === 'disable') registry.disable('ep-drop', now);
    if (what === 'rotate') registry.rotateToken({ endpoint_id: 'ep-drop', now, new_bearer_secret_hmac: computeBearerHmac('new-bearer', PEPPER) });
    if (what === 'expire') now = NOW + 120_000;
    // Leave the dispatcher's cached admission snapshot stale on purpose.
  };
  const rows = () => db.prepare('SELECT blob_id, processing_outcome FROM reception_drop_blob_metadata').all();
  const received = () => auditCalls.filter(event => event.action === 'drop_blob.received');
  return { db, root, registry, drops, cas, start, change, rows, received,
    close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
};

describe.each(['single', 'resumable'] as const)('%s drop admission', transport => {
  it.each(['revoke', 'disable', 'rotate', 'expire'] as const)('refuses %s during the request body wait without storing metadata or emitting received', async change => {
    const f = fixture();
    try {
      const request = await f.start(transport);
      f.change(change); await request.send();
      expect(request.res.statusCode).toBe(410);
      expect(f.rows()).toEqual([]); expect(f.received()).toEqual([]);
    } finally { f.close(); }
  });

  it('refuses revocation during PII sealing and preserves an already shared CAS object', async () => {
    const f = fixture();
    await f.cas.put(PDF);
    const hash = createHash('sha256').update(PDF).digest('hex');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let sealing = false;
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args) => {
      sealing = true; await held; return encrypt(...args);
    });
    let pending: Promise<void> | undefined;
    try {
      const request = await f.start(transport); pending = request.send();
      await vi.waitFor(() => expect(sealing).toBe(true));
      f.change('revoke'); release(); await pending;
      expect(request.res.statusCode).toBe(410);
      expect(f.rows()).toEqual([]); expect(f.received()).toEqual([]);
      expect(await f.cas.get(hash)).toEqual(PDF);
      if (transport === 'single') expect(readdirSync(join(f.root, '_tmp'))).toEqual([]);
    } finally { release(); try { await pending; } finally { spy.mockRestore(); f.close(); } }
  });

  it.each(['one_time', 'daily_cap'] as const)('admits one winner when two uploads race for %s', async limit => {
    const f = fixture(limit === 'one_time' ? { link_kind: 'one_time' } : { max_uploads_per_endpoint_per_day: 1 });
    try {
      const first = await f.start(transport), second = await f.start(transport);
      await Promise.all([first.send(), second.send()]);
      expect([first.res.statusCode, second.res.statusCode].sort()).toEqual(limit === 'one_time' ? [200, 410] : [200, 429]);
      expect(f.drops.listPendingForEndpoint('ep-drop')).toHaveLength(1);
      expect(f.received()).toHaveLength(1);
      expect(await f.cas.get(createHash('sha256').update(PDF).digest('hex'))).toEqual(PDF);
      expect(f.registry.findById('ep-drop')?.revoked_at !== null).toBe(limit === 'one_time');
    } finally { f.close(); }
  });

  it('records a rejected upload without consuming the one-time link or its clean-upload quota', async () => {
    const f = fixture({ link_kind: 'one_time', max_uploads_per_endpoint_per_day: 1 });
    try {
      const rejected = await f.start(transport, { filename: 'wrong.pdf', mime: 'image/png' }); await rejected.send();
      expect(rejected.res.statusCode).toBe(transport === 'single' ? 400 : 415);
      expect(f.registry.findById('ep-drop')?.revoked_at).toBeNull();
      expect(f.drops.countWithinWindow({ endpoint_id: 'ep-drop', window_start_at: NOW - 86_400_000, now: NOW })).toBe(0);
      const accepted = await f.start(transport); await accepted.send();
      expect(accepted.res.statusCode).toBe(200);
      expect(f.rows()).toHaveLength(2);
      expect(f.drops.listPendingForEndpoint('ep-drop')).toHaveLength(1);
      expect(f.registry.findById('ep-drop')?.revoked_at).not.toBeNull();
    } finally { f.close(); }
  });
});

it('does not persist a rejected-filename row after revocation during the single-upload body wait', async () => {
  const f = fixture();
  try {
    const request = await f.start('single', { filename: '..' });
    f.change('revoke'); await request.send();
    expect(request.res.statusCode).toBe(410); expect(f.rows()).toEqual([]);
  } finally { f.close(); }
});

const metadataInput = (blob_id: string) => ({
  blob_id, endpoint_id: 'ep-drop', uploaded_at: NOW, source_ip_hash: null,
  visitor_email_encrypted: null, visitor_name_encrypted: null, visitor_description_encrypted: null,
  filename_sanitized: 'report.pdf', mime_type_reported: 'application/pdf', mime_type_detected: 'application/pdf',
  size_bytes: PDF.length, content_hash: 'fixture-hash', storage_path: 'fixture-hash', processing_outcome: 'pending' as const,
});

it('shares one-time admission between single-request and resumable uploads', async () => {
  const f = fixture({ link_kind: 'one_time' });
  try {
    const single = await f.start('single'), resumable = await f.start('resumable');
    await Promise.all([single.send(), resumable.send()]);
    expect([single.res.statusCode, resumable.res.statusCode].sort()).toEqual([200, 410]);
    expect(f.rows()).toHaveLength(1); expect(f.received()).toHaveLength(1);
  } finally { f.close(); }
});

it('locks out another registry writer from authorization through metadata insertion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drop-admission-wal-'));
  const databasePath = join(dir, 'reception.sqlite');
  const f = fixture({}, databasePath);
  f.db.pragma('journal_mode = WAL');
  const peer = new Database(databasePath);
  peer.pragma('busy_timeout = 0');
  const peerRegistry = createPublicEndpointRegistryStore(peer);
  const authorize = () => f.registry.verifyBearer({ endpoint_id: 'ep-drop',
    submitted_secret: 'fixture-bearer', pepper: PEPPER, now: NOW }).kind === 'ok';
  try {
    expect(admitDropBlob({ registry: f.registry, drops: f.drops, input: metadataInput('denied'), now: NOW,
      authorize: () => false })).toEqual({ conflict: 'not_authorized' });
    const accepted = admitDropBlob({ registry: f.registry, drops: f.drops, input: metadataInput('accepted'), now: NOW,
      authorize: () => {
        expect(() => peerRegistry.revoke({ endpoint_id: 'ep-drop', now: NOW, reason: 'Concurrent owner revoke' }))
          .toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }));
        return authorize();
      } });
    expect(accepted).toHaveProperty('row.blob_id', 'accepted');
    peerRegistry.revoke({ endpoint_id: 'ep-drop', now: NOW, reason: 'Owner revoke after commit' });
    expect(admitDropBlob({ registry: f.registry, drops: f.drops, input: metadataInput('revoked'), now: NOW,
      authorize })).toEqual({ conflict: 'not_authorized' });
    expect(f.rows()).toEqual([{ blob_id: 'accepted', processing_outcome: 'pending' }]);
  } finally { peer.close(); f.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('rolls back both metadata and one-time revocation if consumption fails, then permits a retry', () => {
  const f = fixture({ link_kind: 'one_time', max_uploads_per_endpoint_per_day: 1 });
  const revoke = f.registry.revoke.bind(f.registry);
  const spy = vi.spyOn(f.registry, 'revoke').mockImplementation(input => {
    revoke(input); throw new Error('consumption failed');
  });
  try {
    expect(() => admitDropBlob({ registry: f.registry, drops: f.drops, input: metadataInput('retry'),
      now: NOW, authorize: () => true })).toThrow('consumption failed');
    expect(f.rows()).toEqual([]); expect(f.registry.findById('ep-drop')?.revoked_at).toBeNull();
    spy.mockRestore();
    expect(admitDropBlob({ registry: f.registry, drops: f.drops, input: metadataInput('retry'),
      now: NOW, authorize: () => true })).toHaveProperty('one_time_consumed', true);
    expect(f.rows()).toHaveLength(1); expect(f.registry.findById('ep-drop')?.revoked_at).not.toBeNull();
  } finally { spy.mockRestore(); f.close(); }
});

it('counts a concurrent accepted upload with a later clock stamp at the quota boundary', () => {
  const f = fixture({ max_uploads_per_endpoint_per_day: 1 });
  try {
    f.drops.insert({ ...metadataInput('future'), uploaded_at: NOW + 1000 });
    expect(admitDropBlob({ registry: f.registry, drops: f.drops, input: metadataInput('denied'),
      now: NOW, authorize: () => true })).toEqual({ conflict: 'day_cap' });
    expect(f.rows()).toHaveLength(1);
  } finally { f.close(); }
});

describe('single-upload dispatcher proxy origin policy', () => {
  it.each(['origin', 'referer'] as const)('rejects a downgraded %s behind a trusted HTTPS proxy without spending the nonce', async source => {
    const f = fixture({}, ':memory:', true);
    try {
      const headers = { origin: undefined, [source]: 'http://localhost', 'x-forwarded-proto': 'https' };
      const denied = await f.start('single', { headers }); await denied.send();
      expect(denied.res.statusCode).toBe(403);
      expect(f.rows()).toEqual([]); expect(f.received()).toEqual([]);
      const accepted = await f.start('single', { headers: { ...headers, [source]: 'https://localhost' }, formNonce: denied.formNonce });
      await accepted.send();
      expect(accepted.res.statusCode).toBe(200); expect(f.rows()).toHaveLength(1);
    } finally { f.close(); }
  });

  it('ignores a forged forwarded scheme on a direct listener', async () => {
    const f = fixture();
    try {
      const request = await f.start('single', { headers: { origin: 'http://localhost', 'x-forwarded-proto': 'https' } });
      await request.send();
      expect(request.res.statusCode).toBe(200); expect(f.rows()).toHaveLength(1);
    } finally { f.close(); }
  });

  it('permits a no-JS opaque origin only with a valid form nonce', async () => {
    const f = fixture({}, ':memory:', true);
    const headers = { origin: 'null', 'x-forwarded-proto': 'https' };
    try {
      const denied = await f.start('single', { headers, formNonce: 'never-issued' }); await denied.send();
      expect(denied.res.statusCode).toBe(400); expect(f.rows()).toEqual([]);
      const accepted = await f.start('single', { headers }); await accepted.send();
      expect(accepted.res.statusCode).toBe(200); expect(f.rows()).toHaveLength(1);
    } finally { f.close(); }
  });
});
