import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import {
  createAuditLogStore,
  type AuditEntry,
  type ActivityEntry,
} from '@recued/storage';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createSQLiteCollection } from '../sqlite-collection.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createCollectionRegistry } from '../collections/registry.js';
import {
  createWebhookCollection,
  type WebhookCollectionConfig,
} from '../collections/webhook/webhook-collection.js';
import {
  createWebhookListener,
  type WebhookRequestHandler,
} from '../collections/webhook/webhook-listener.js';

const BIG_QUOTA = 100 * 1024 * 1024;

interface Harness {
  dir: string;
  db: Database.Database;
  registry: ReturnType<typeof createCollectionRegistry>;
  listener: WebhookRequestHandler;
  url: string;
  publicReachable: { value: boolean };
  isPaused: { value: boolean };
  secrets: Map<string, string>;
  close(): Promise<void>;
}

const startHttp = (handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<{
  url: string;
  close: () => Promise<void>;
}> => new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: { message: err.message } }));
    });
  });
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as AddressInfo;
    resolve({
      url: `http://127.0.0.1:${addr.port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    });
  });
});

const setupWebhook = async (configOverrides: Partial<WebhookCollectionConfig> = {}): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-listener-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const gate = createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:webhook:github' });
  const blobs = createBlobStore(join(dataDir, 'blobs'));
  const bus = createWarehouseEventBus();
  const auditLog = createAuditLogStore(
    createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
    createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
  );
  const registry = createCollectionRegistry();
  const config: WebhookCollectionConfig = {
    retention_days: 30,
    quota_bytes: BIG_QUOTA,
    ...configOverrides,
  };
  const collection = createWebhookCollection({
    db, blobs, gate, bus, slug: 'github',
    config: () => config,
    auditLog,
  });
  registry.register(collection);
  await collection.sync.start();

  const publicReachable = { value: true };
  const isPaused = { value: false };
  const secrets = new Map<string, string>();
  const listener = createWebhookListener({
    registry,
    publicReachable: () => publicReachable.value,
    isPaused: () => isPaused.value,
    getHmacSecret: (slug, vaultKey) => secrets.get(`${slug}:${vaultKey}`) ?? null,
  });

  const http = await startHttp(async (req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/webhook/')) {
      const slug = decodeURIComponent(url.slice('/webhook/'.length).split('?')[0]);
      await listener(req, res, slug);
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  return {
    dir, db, registry, listener,
    url: http.url,
    publicReachable,
    isPaused,
    secrets,
    async close() {
      await http.close();
      await collection.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let h: Harness;
afterEach(async () => { await h?.close(); });

describe('listener — public_reachable gate (D-096)', () => {
  beforeEach(async () => { h = await setupWebhook(); });

  it('returns 503 WEBHOOK_UNAVAILABLE when public_reachable=false', async () => {
    h.publicReachable.value = false;
    const res = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('WEBHOOK_UNAVAILABLE');
  });

  it('accepts requests when public_reachable=true', async () => {
    const res = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(202);
  });
});

describe('listener — D-188 master pause', () => {
  beforeEach(async () => { h = await setupWebhook(); });

  it('returns 503 SERVER_PAUSED while paused (intake closed, checked before reachability)', async () => {
    h.isPaused.value = true;
    const res = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('SERVER_PAUSED');
  });

  it('accepts requests again once resumed', async () => {
    h.isPaused.value = true;
    await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    h.isPaused.value = false; // resume is instant — the thunk is read per-request
    const res = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(202);
  });
});

describe('listener — routing + errors', () => {
  beforeEach(async () => { h = await setupWebhook(); });

  it('returns 404 COLLECTION_NOT_FOUND for unknown slug', async () => {
    const res = await fetch(`${h.url}/webhook/unregistered`, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('COLLECTION_NOT_FOUND');
  });

  it('returns 202 + delivery_id on success', async () => {
    const res = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body: '{"event":"push"}',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.delivery_id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('persists a record the recipe can read via list()', async () => {
    await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body: '{"event":"push"}',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
    });
    const collection = h.registry.get('webhook', 'github')!;
    const records = collection.list({ platform: 'webhook', slug: 'github' });
    expect(records.length).toBe(1);
    expect(records[0].hot_fields.method).toBe('POST');
    expect(records[0].hot_fields.content_type).toBe('application/json');
    expect(records[0].hot_fields.headers_subset).toMatchObject({ 'x-github-event': 'push' });
  });
});

describe('listener — rate limiting', () => {
  beforeEach(async () => { h = await setupWebhook({ rate_limit_per_second: 1, rate_limit_burst: 2 }); });

  it('returns 429 when the bucket is empty', async () => {
    const first = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    const second = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    const third = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(third.status).toBe(429);
    const body = await third.json();
    expect(body.error.code).toBe('rate_limited');
  });
});

describe('listener — HMAC', () => {
  const secret = 'whsec';
  const body = '{"event":"push"}';
  const signature = createHmac('sha256', secret).update(body).digest('hex');

  beforeEach(async () => {
    h = await setupWebhook({
      hmac_header: 'X-Hub-Signature-256',
      hmac_secret_vault_key: 'webhook.github.secret',
    });
    h.secrets.set('github:webhook.github.secret', secret);
  });

  it('accepts requests with a valid signature', async () => {
    const res = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${signature}`,
      },
    });
    expect(res.status).toBe(202);
  });

  it('rejects requests without a signature header', async () => {
    const res = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with a bad signature', async () => {
    const res = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${'0'.repeat(signature.length)}`,
      },
    });
    expect(res.status).toBe(401);
  });
});

describe('listener — body cap', () => {
  beforeEach(async () => { h = await setupWebhook({ max_body_bytes: 1024 }); });

  it('returns 413 when the body exceeds the cap', async () => {
    const res = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body: 'x'.repeat(2048),
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.status).toBe(413);
  });
});

describe('listener — draining', () => {
  beforeEach(async () => { h = await setupWebhook(); });

  it('returns 503 after the collection stops accepting', async () => {
    const collection = h.registry.get('webhook', 'github')!;
    await collection.close();
    const res = await fetch(`${h.url}/webhook/github`, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('not_accepting');
  });
});
