import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStorageGate, type StorageGate } from '@recued/storage-gate';
import {
  createAuditLogStore,
  type AuditLogStore,
  type AuditEntry,
  type ActivityEntry,
} from '@recued/storage';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
  type WarehouseEventBus,
} from '@recued/warehouse-events';

import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import {
  createWebhookCollection,
  verifyHmac,
  type WebhookCollection,
  type WebhookCollectionConfig,
} from '../collections/webhook/webhook-collection.js';

const BIG_QUOTA = 100 * 1024 * 1024;

interface Harness {
  dir: string;
  db: Database.Database;
  gate: StorageGate;
  blobs: BlobStore;
  bus: WarehouseEventBus;
  auditLog: AuditLogStore;
  events: WarehouseEvent[];
  collection: WebhookCollection;
  config: WebhookCollectionConfig;
  close(): void;
}

const newHarness = (
  overrides: Partial<WebhookCollectionConfig> = {},
  options: { wrapBlobs?: (blobs: BlobStore) => BlobStore } = {},
): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-collection-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const gate = createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:webhook:github' });
  const baseBlobs = createBlobStore(join(dataDir, 'blobs'));
  const blobs = options.wrapBlobs?.(baseBlobs) ?? baseBlobs;
  const bus = createWarehouseEventBus();
  const auditLog = createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
    createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
  );
  const events: WarehouseEvent[] = [];
  bus.subscribe('**', (e) => { events.push(e); });
  const config: WebhookCollectionConfig = {
    retention_days: 30,
    quota_bytes: BIG_QUOTA,
    ...overrides,
  };
  const collection = createWebhookCollection({
    db, blobs, gate, bus,
    slug: 'github',
    config: () => config,
    auditLog,
  });
  return {
    dir, db, gate, blobs, bus, auditLog, events, collection, config,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let h: Harness;
afterEach(() => { h?.close(); });

// ────────────────────────────────────────────────────────────────
// verifyHmac
// ────────────────────────────────────────────────────────────────

describe('verifyHmac', () => {
  const secret = 'topsecret';
  const body = Buffer.from('{"event":"push"}');
  const expected = createHmac('sha256', secret).update(body).digest('hex');

  it('accepts the bare hex form', () => {
    expect(verifyHmac(secret, body, expected)).toBe(true);
  });

  it('accepts the sha256= prefixed form', () => {
    expect(verifyHmac(secret, body, `sha256=${expected}`)).toBe(true);
  });

  it('rejects a mismatched signature', () => {
    expect(verifyHmac(secret, body, expected.replace(/.$/, 'x'))).toBe(false);
  });

  it('rejects a wrong-length signature', () => {
    expect(verifyHmac(secret, body, 'short')).toBe(false);
  });

  it('rejects non-hex input safely', () => {
    expect(verifyHmac(secret, body, 'zzzz')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// accepting() + sync lifecycle
// ────────────────────────────────────────────────────────────────

describe('sync lifecycle', () => {
  beforeEach(() => { h = newHarness(); });

  it('rejects deliveries before start()', async () => {
    const res = await h.collection.ingest({
      method: 'POST', body: Buffer.from('x'), contentType: 'text/plain',
      headersSubset: {}, query: {}, remoteIp: '127.0.0.1',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(503);
  });

  it('accepts after start() and rejects after stop()', async () => {
    await h.collection.sync.start();
    expect(h.collection.accepting()).toBe(true);
    const res1 = await h.collection.ingest({
      method: 'POST', body: Buffer.from('hi'), contentType: 'text/plain',
      headersSubset: {}, query: {}, remoteIp: '127.0.0.1',
    });
    expect(res1.ok).toBe(true);
    await h.collection.sync.stop();
    expect(h.collection.accepting()).toBe(false);
    const res2 = await h.collection.ingest({
      method: 'POST', body: Buffer.from('hi'), contentType: 'text/plain',
      headersSubset: {}, query: {}, remoteIp: '127.0.0.1',
    });
    expect(res2.ok).toBe(false);
  });

  it('closes admission immediately and waits for an accepted ingest', async () => {
    let putStarted!: () => void;
    const started = new Promise<void>((resolve) => { putStarted = resolve; });
    let releasePut!: () => void;
    const putGate = new Promise<void>((resolve) => { releasePut = resolve; });
    h = newHarness(
      { max_body_bytes: 200 * 1024 },
      {
        wrapBlobs: (blobs) => ({
          ...blobs,
          async put(data) {
            putStarted();
            await putGate;
            return blobs.put(data);
          },
        }),
      },
    );
    await h.collection.sync.start();
    const ingesting = h.collection.ingest({
      method: 'POST',
      body: Buffer.alloc(64 * 1024 + 1, 0x41),
      contentType: 'application/octet-stream',
      headersSubset: {},
      query: {},
      remoteIp: '127.0.0.1',
    });
    await started;

    let closeSettled = false;
    const closing = h.collection.close().then(() => { closeSettled = true; });
    expect(h.collection.accepting()).toBe(false);
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    await expect(h.collection.ingest({
      method: 'POST',
      body: Buffer.from('late'),
      contentType: 'text/plain',
      headersSubset: {},
      query: {},
      remoteIp: '127.0.0.1',
    })).resolves.toMatchObject({ ok: false, status: 503 });

    releasePut();
    await expect(ingesting).resolves.toMatchObject({ ok: true });
    await closing;
    expect(closeSettled).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// ingest — happy path
// ────────────────────────────────────────────────────────────────

describe('ingest — happy path', () => {
  beforeEach(async () => {
    h = newHarness();
    await h.collection.sync.start();
  });

  it('persists a record with ULID-shaped delivery_id + hot_fields', async () => {
    const res = await h.collection.ingest({
      method: 'post',
      body: Buffer.from('{"event":"push"}'),
      contentType: 'application/json',
      headersSubset: { 'user-agent': 'test' },
      query: { q: '1' },
      remoteIp: '10.0.0.5',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delivery_id).toMatch(/^[0-9A-Z]{26}$/);
    expect(res.record_id).toBe(`webhook:${res.delivery_id}`);
    const rec = h.collection.get(res.record_id)!;
    expect(rec.hot_fields).toMatchObject({
      method: 'POST',
      headers_subset: { 'user-agent': 'test' },
      remote_ip: '10.0.0.5',
      query: { q: '1' },
      content_type: 'application/json',
    });
    expect(rec.body_inline).toBe('{"event":"push"}');
  });

  it('emits a created event per delivery', async () => {
    await h.collection.ingest({
      method: 'POST', body: Buffer.from('{}'), contentType: 'application/json',
      headersSubset: {}, query: {}, remoteIp: '127.0.0.1',
    });
    const created = h.events.filter((e) => e.event_kind === 'created');
    expect(created.length).toBe(1);
    expect(created[0].platform).toBe('webhook');
    expect(created[0].slug).toBe('github');
  });

  it('emits a webhook_received audit activity (non-reserve)', async () => {
    await h.collection.ingest({
      method: 'POST', body: Buffer.from('{}'), contentType: 'application/json',
      headersSubset: {}, query: {}, remoteIp: '127.0.0.1',
    });
    const acts = await h.auditLog.listActivities(10);
    const received = acts.find((a) => a.action === 'webhook_received');
    expect(received).toBeDefined();
    expect(received?.target).toBe('collection:webhook:github');
    expect(received?.reserve).toBeFalsy();
  });
});

// ────────────────────────────────────────────────────────────────
// ingest — validation
// ────────────────────────────────────────────────────────────────

describe('ingest — validation', () => {
  it('rejects over-cap bodies', async () => {
    h = newHarness({ max_body_bytes: 100 });
    await h.collection.sync.start();
    const res = await h.collection.ingest({
      method: 'POST', body: Buffer.alloc(200, 'x'), contentType: 'text/plain',
      headersSubset: {}, query: {}, remoteIp: '127.0.0.1',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(413);
  });

  it('rejects disallowed content types', async () => {
    h = newHarness({ accept_content_types: ['application/json'] });
    await h.collection.sync.start();
    const res = await h.collection.ingest({
      method: 'POST', body: Buffer.from('<xml/>'), contentType: 'application/xml',
      headersSubset: {}, query: {}, remoteIp: '127.0.0.1',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(415);
  });

  it('rejects IPs outside the allowlist', async () => {
    h = newHarness({ ip_allowlist: ['10.0.0.1'] });
    await h.collection.sync.start();
    const res = await h.collection.ingest({
      method: 'POST', body: Buffer.from('{}'), contentType: 'application/json',
      headersSubset: {}, query: {}, remoteIp: '8.8.8.8',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────
// ingest — HMAC
// ────────────────────────────────────────────────────────────────

describe('ingest — HMAC verification', () => {
  const secret = 'whsec';
  const body = Buffer.from('{"hello":"world"}');
  const signature = createHmac('sha256', secret).update(body).digest('hex');

  beforeEach(async () => {
    h = newHarness({ hmac_header: 'X-Hub-Signature-256', hmac_secret_vault_key: 'webhook.github.secret' });
    await h.collection.sync.start();
  });

  it('accepts a valid signature', async () => {
    const res = await h.collection.ingest({
      method: 'POST', body, contentType: 'application/json',
      headersSubset: {}, query: {}, remoteIp: '10.0.0.1',
      hmacHeader: `sha256=${signature}`,
      hmacSecret: secret,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects when the header is missing', async () => {
    const res = await h.collection.ingest({
      method: 'POST', body, contentType: 'application/json',
      headersSubset: {}, query: {}, remoteIp: '10.0.0.1',
      hmacHeader: null, hmacSecret: secret,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('rejects when the secret is missing (fails closed)', async () => {
    const res = await h.collection.ingest({
      method: 'POST', body, contentType: 'application/json',
      headersSubset: {}, query: {}, remoteIp: '10.0.0.1',
      hmacHeader: `sha256=${signature}`, hmacSecret: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('rejects a mismatched signature', async () => {
    const res = await h.collection.ingest({
      method: 'POST', body, contentType: 'application/json',
      headersSubset: {}, query: {}, remoteIp: '10.0.0.1',
      hmacHeader: `sha256=${'0'.repeat(signature.length)}`,
      hmacSecret: secret,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('emits a webhook_rejected_auth audit row (reserve-class)', async () => {
    await h.collection.ingest({
      method: 'POST', body, contentType: 'application/json',
      headersSubset: {}, query: {}, remoteIp: '10.0.0.1',
      hmacHeader: null, hmacSecret: secret,
    });
    const acts = await h.auditLog.listActivities(10);
    const rejected = acts.find((a) => a.action === 'webhook_rejected_auth');
    expect(rejected).toBeDefined();
    expect(rejected?.reserve).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// body split (inline vs CAS)
// ────────────────────────────────────────────────────────────────

describe('body storage split', () => {
  beforeEach(async () => {
    h = newHarness({ max_body_bytes: 200 * 1024 });
    await h.collection.sync.start();
  });

  it('stores ≤ 64 KB bodies inline (utf8 for json)', async () => {
    const res = await h.collection.ingest({
      method: 'POST', body: Buffer.from('{"x":1}'), contentType: 'application/json',
      headersSubset: {}, query: {}, remoteIp: '127.0.0.1',
    });
    if (!res.ok) throw new Error('ingest failed');
    const rec = h.collection.get(res.record_id)!;
    expect(rec.body_inline).toBe('{"x":1}');
    expect(rec.blob_hash).toBeUndefined();
  });

  it('spills > 64 KB bodies to CAS', async () => {
    const content = Buffer.alloc(64 * 1024 + 1, 0x41);
    const res = await h.collection.ingest({
      method: 'POST', body: content, contentType: 'application/octet-stream',
      headersSubset: {}, query: {}, remoteIp: '127.0.0.1',
    });
    if (!res.ok) throw new Error('ingest failed');
    const rec = h.collection.get(res.record_id)!;
    expect(rec.body_inline).toBeUndefined();
    expect(typeof rec.blob_hash).toBe('string');
    const stored = await h.blobs.get(rec.blob_hash!);
    expect(stored?.length).toBe(content.length);
  });
});
