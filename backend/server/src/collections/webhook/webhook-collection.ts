/** Phase D (D-106) — webhook collection.
 *
 *  Push-based: the server's HTTP listener (webhook-listener.ts)
 *  accepts POST /webhook/{slug} requests and calls `ingest()` on
 *  the matching collection. No sync loop here — `sync.start/stop`
 *  flip an `accepting` flag that the listener checks before calling
 *  `ingest()`, so the drain pipeline can refuse new deliveries
 *  without tearing down the HTTP route.
 *
 *  Per D-096, the webhook listener itself is self-host only; the
 *  cloud never relays inbound webhooks. Commit 10 adds the
 *  `public_reachable` gate at the listener layer. This file stays
 *  runtime-agnostic so tests can exercise `ingest()` directly.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
import type {
  CollectionHealth,
  CollectionListQuery,
  CollectionRecord,
  CollectionSearchMatch,
  CollectionSearchQuery,
  CollectionState,
} from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import type { BlobStore } from '../../storage/blob-store.js';
import {
  createCollectionTable,
  INLINE_CUTOFF_BYTES,
  type CollectionTable,
} from '../table.js';
import { createCollectionEmitter } from '../events.js';
import {
  createCollectionRetention,
  type CollectionRetention,
} from '../retention.js';
import type {
  Collection,
  CollectionPruneResult,
  CollectionSyncAdapter,
} from '../types.js';

export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

/** Default rate limit per endpoint — 100 req/s with bursts of 10. */
export const DEFAULT_WEBHOOK_RATE_LIMIT_PER_SECOND = 100;
export const DEFAULT_WEBHOOK_RATE_LIMIT_BURST = 10;

export interface WebhookCollectionConfig {
  retention_days: number;
  quota_bytes: number;
  /** Cap inbound body size. Defaults to 1 MB — matches spec §webhook. */
  max_body_bytes?: number;
  /** HMAC header to read (e.g. `X-Hub-Signature-256`). When unset
   *  HMAC is disabled. */
  hmac_header?: string;
  /** Vault key that resolves to the shared secret (looked up by the
   *  listener + handed in via `ingest.hmacSecret`). Declared here
   *  so collection config stays declarative; the listener owns the
   *  vault access. */
  hmac_secret_vault_key?: string;
  /** Allowed content types. Empty / undefined = accept any. */
  accept_content_types?: string[];
  /** Optional IP allowlist. When set, any other remote_ip gets 401. */
  ip_allowlist?: string[];
  /** Token-bucket rate limit per endpoint, requests per second. */
  rate_limit_per_second?: number;
  /** Token-bucket burst size. */
  rate_limit_burst?: number;
}

export interface CreateWebhookCollectionOptions {
  db: Database.Database;
  blobs: BlobStore;
  gate: StorageGate;
  bus: WarehouseEventBus;
  slug: string;
  config: () => WebhookCollectionConfig;
  auditLog?: AuditLogStore;
  now?: () => number;
}

export interface WebhookIngestInput {
  method: string;
  /** Raw request body bytes. */
  body: Buffer;
  /** Resolved `Content-Type` header (trimmed, no parameters). */
  contentType: string | null;
  /** Subset of headers worth persisting as hot_fields. Only trusted
   *  ones (the listener trims down the full header set). */
  headersSubset: Record<string, string>;
  /** Parsed query string. */
  query: Record<string, string>;
  /** Remote IP; `null` when the request came from a local socket. */
  remoteIp: string | null;
  /** Value of `config.hmac_header` if present in the request, else null. */
  hmacHeader?: string | null;
  /** Shared secret the listener resolved via vault; null when not
   *  configured. Absent → HMAC disabled. */
  hmacSecret?: string | null;
}

export type WebhookIngestResult =
  | { ok: true; delivery_id: string; record_id: string }
  | { ok: false; status: number; code: string; message: string };

/** `WebhookCollection` extends `Collection` with the push-mode
 *  `ingest` entrypoint the listener calls per inbound POST. */
export interface WebhookCollection extends Collection {
  /** Accepts one inbound delivery. Validates + persists + emits
   *  `created`. Returns an error envelope instead of throwing so
   *  the listener can translate it into the matching HTTP status. */
  ingest(input: WebhookIngestInput): Promise<WebhookIngestResult>;
  /** True iff the sync adapter is accepting deliveries (i.e. the
   *  adapter is started and not yet stopped by drain). */
  accepting(): boolean;
  /** Live config — reads `opts.config()` so per-endpoint knobs
   *  (rate limits, body cap, HMAC header) stay in sync with
   *  `server.setConfigField` edits. */
  config(): WebhookCollectionConfig;
}

// ────────────────────────────────────────────────────────────────
// ULID (monotonic-ish sortable id for delivery records).
// 10 chars of timestamp (base32) + 16 chars of randomness.
// ────────────────────────────────────────────────────────────────

const CROCKFORD_32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const ulid = (now: number, rand: () => Uint8Array): string => {
  let time = now;
  let timeStr = '';
  for (let i = 0; i < 10; i++) {
    timeStr = CROCKFORD_32[time % 32] + timeStr;
    time = Math.floor(time / 32);
  }
  const bytes = rand();
  let randStr = '';
  for (let i = 0; i < 16; i++) {
    randStr += CROCKFORD_32[bytes[i] % 32];
  }
  return timeStr + randStr;
};

// ────────────────────────────────────────────────────────────────
// HMAC
// ────────────────────────────────────────────────────────────────

/** Constant-time-compare the provided header against an HMAC
 *  signature of the body. Accepts both `sha256=hex` (GitHub/Slack-
 *  style) and bare hex (Stripe). */
export const verifyHmac = (
  secret: string,
  body: Buffer,
  provided: string,
): boolean => {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const clean = provided.startsWith('sha256=') ? provided.slice(7) : provided;
  if (clean.length !== expected.length) return false;
  let eBytes: Buffer;
  let cBytes: Buffer;
  try {
    eBytes = Buffer.from(expected, 'hex');
    cBytes = Buffer.from(clean, 'hex');
  } catch {
    return false;
  }
  if (eBytes.length !== cBytes.length) return false;
  return timingSafeEqual(eBytes, cBytes);
};

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

export const createWebhookCollection = (
  opts: CreateWebhookCollectionOptions,
): WebhookCollection => {
  const { db, blobs, gate, bus, slug } = opts;
  const nowOf = (): number => opts.now?.() ?? Date.now();

  const table: CollectionTable = createCollectionTable({
    db,
    platform: 'webhook',
    slug,
    onBytesChanged: (delta) => { gate.addUsed(delta); },
  });

  const emitter = createCollectionEmitter({
    bus,
    platform: 'webhook',
    slug,
    entityType: 'webhook_delivery',
    now: () => nowOf(),
  });

  const retention: CollectionRetention = createCollectionRetention({
    table,
    platform: 'webhook',
    slug,
    auditLog: opts.auditLog,
    now: () => nowOf(),
    config: () => ({ retentionDays: opts.config().retention_days }),
  });

  let accepting = false;
  let state: CollectionState = 'idle';
  let lastIndexedAt = 0;
  let errorCount24h = 0;

  const sync: CollectionSyncAdapter = {
    async start() {
      accepting = true;
      state = 'connected';
    },
    async stop() {
      accepting = false;
      state = 'disconnected';
    },
  };

  const ingest = async (input: WebhookIngestInput): Promise<WebhookIngestResult> => {
    if (!accepting) {
      return { ok: false, status: 503, code: 'not_accepting', message: 'webhook collection is not accepting deliveries' };
    }

    const cfg = opts.config();
    const max = cfg.max_body_bytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;
    if (input.body.length > max) {
      return { ok: false, status: 413, code: 'payload_too_large', message: `body exceeds ${max} bytes` };
    }

    const accepted = cfg.accept_content_types;
    if (accepted && accepted.length > 0) {
      const ct = (input.contentType ?? '').toLowerCase();
      const matched = accepted.some((t) => ct === t.toLowerCase());
      if (!matched) {
        return { ok: false, status: 415, code: 'unsupported_media_type', message: `content-type '${ct}' not in accept list` };
      }
    }

    if (cfg.ip_allowlist && cfg.ip_allowlist.length > 0) {
      const ip = input.remoteIp ?? '';
      if (!cfg.ip_allowlist.includes(ip)) {
        return { ok: false, status: 401, code: 'ip_not_allowed', message: 'remote ip is not in the allowlist' };
      }
    }

    // HMAC verification only fires when the config + the ingest input
    // both carry the matching bits. Misconfigured secrets fail closed.
    if (cfg.hmac_header) {
      const provided = input.hmacHeader ?? null;
      const secret = input.hmacSecret ?? null;
      if (!secret) {
        errorCount24h++;
        await logRejectedAuth('hmac_secret_missing');
        return { ok: false, status: 401, code: 'auth_failed', message: 'hmac secret unavailable' };
      }
      if (!provided) {
        errorCount24h++;
        await logRejectedAuth('hmac_header_missing');
        return { ok: false, status: 401, code: 'auth_failed', message: `missing ${cfg.hmac_header} header` };
      }
      const ok = verifyHmac(secret, input.body, provided);
      if (!ok) {
        errorCount24h++;
        await logRejectedAuth('hmac_mismatch');
        return { ok: false, status: 401, code: 'auth_failed', message: 'hmac verification failed' };
      }
    }

    // Persist the delivery.
    const deliveryId = ulid(nowOf(), () => randomBytes(16));
    const recordId = `webhook:${deliveryId}`;
    const size = input.body.length;
    const hotFields: Record<string, unknown> = {
      method: input.method.toUpperCase(),
      headers_subset: input.headersSubset,
      remote_ip: input.remoteIp ?? '',
      query: input.query,
      content_type: input.contentType ?? '',
    };
    let body_inline: string | undefined;
    let blob_hash: string | undefined;
    if (size <= INLINE_CUTOFF_BYTES) {
      // Text content types round-trip as utf8; everything else as
      // base64 so binary deliveries stay inspectable after retrieval.
      const ct = (input.contentType ?? '').toLowerCase();
      body_inline = ct.startsWith('text/') || ct === 'application/json' || ct === 'application/x-www-form-urlencoded'
        ? input.body.toString('utf8')
        : input.body.toString('base64');
    } else {
      blob_hash = await blobs.put(input.body);
    }

    const record: CollectionRecord = {
      record_id: recordId,
      received_at: nowOf(),
      modified_at: nowOf(),
      hot_fields: hotFields,
      size_bytes: size,
      source_id: deliveryId,
    };
    if (body_inline !== undefined) record.body_inline = body_inline;
    if (blob_hash !== undefined) record.blob_hash = blob_hash;

    try {
      table.upsert(record);
      emitter.created(recordId);
      lastIndexedAt = record.received_at;
      if (opts.auditLog) {
        try {
          await opts.auditLog.logActivity({
            activity_id: '',
            timestamp: record.received_at,
            action: 'webhook_received',
            target: `collection:webhook:${slug}`,
            detail: `method=${record.hot_fields.method} bytes=${size}`,
          });
        } catch { /* best-effort */ }
      }
    } catch (err) {
      errorCount24h++;
      return { ok: false, status: 500, code: 'ingest_failed', message: err instanceof Error ? err.message : String(err) };
    }

    return { ok: true, delivery_id: deliveryId, record_id: recordId };
  };

  const logRejectedAuth = async (reason: string): Promise<void> => {
    if (!opts.auditLog) return;
    try {
      await opts.auditLog.logActivity({
        activity_id: '',
        timestamp: nowOf(),
        action: 'webhook_rejected_auth',
        target: `collection:webhook:${slug}`,
        detail: reason,
      });
    } catch { /* best-effort */ }
  };

  const health = (): CollectionHealth => ({
    platform: 'webhook',
    slug,
    last_indexed_at: lastIndexedAt,
    pending_queue_size: 0,
    error_count_24h: errorCount24h,
    state,
  });

  const runRetention = async (): Promise<CollectionPruneResult> => retention.run();

  return {
    platform: 'webhook',
    slug,
    gate,
    sync,
    upsert: (record) => { table.upsert(record); },
    delete: (record_id) => table.delete(record_id) !== null,
    get: (record_id) => table.get(record_id),
    list: (query: CollectionListQuery) => table.list(query),
    search: (query: CollectionSearchQuery): CollectionSearchMatch[] => table.search(query),
    health,
    runRetention,
    async close() { await sync.stop(); },
    ingest,
    accepting: () => accepting,
    config: () => opts.config(),
  };
};
