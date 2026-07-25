/** D-149 P3 § Contract Tightening — Rate-limit substrate ratchet.
 *
 *  Acceptance per spec § Contract Tightening + § Must Hold I-10:
 *
 *    - In-memory token bucket honors per_ip_global + per_endpoint_kind.
 *    - Bucket replenishes after window_ms.
 *    - SQLite snapshot persists state across simulated restart.
 *    - Per-endpoint daily cap enforces uncapped (reception_page) ⇒ ok.
 *    - Pre-verify (I-10) runs the global + per-kind buckets BEFORE
 *      HMAC compute; the post-verify daily-cap call runs after.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { RECEPTION_RATE_LIMIT_DEFAULTS } from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  buildBucketKey,
  createReceptionRateLimiter,
} from '../ports/reception/rate-limiter.js';

const NOW = 1_700_000_000_000;

describe('D-149 P3 § Contract Tightening — Rate-limit substrate', () => {
  it('per_ip_global accepts up to max_requests; rejects on overflow', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const limiter = createReceptionRateLimiter({ db });
    const limit = RECEPTION_RATE_LIMIT_DEFAULTS.per_ip_global.max_requests;
    for (let i = 0; i < limit; i++) {
      const r = limiter.consumePreVerify({
        source_ip_hash: 'hash-1',
        endpoint_kind: 'reception_page',
        now: NOW,
      });
      expect(r.ok).toBe(true);
    }
    const overflow = limiter.consumePreVerify({
      source_ip_hash: 'hash-1',
      endpoint_kind: 'reception_page',
      now: NOW,
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.bucket_kind).toBe('per_ip_global');
  });

  it('per_endpoint_kind drop_link caps at 5 per hour (tighter than global)', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const limiter = createReceptionRateLimiter({ db });
    for (let i = 0; i < 5; i++) {
      const r = limiter.consumePreVerify({
        source_ip_hash: 'hash-2',
        endpoint_kind: 'drop_link',
        now: NOW,
      });
      expect(r.ok).toBe(true);
    }
    const overflow = limiter.consumePreVerify({
      source_ip_hash: 'hash-2',
      endpoint_kind: 'drop_link',
      now: NOW,
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      // Could either be global (60/min) or per-endpoint-kind (5/hour)
      // depending on which bucket exhausts first; with 5 requests it's
      // the per-kind bucket.
      expect(['per_ip_per_endpoint', 'per_ip_global']).toContain(overflow.bucket_kind);
    }
  });

  it('per_endpoint_daily_cap enforces drop_link 50/day post-verify', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const limiter = createReceptionRateLimiter({ db });
    const cap = RECEPTION_RATE_LIMIT_DEFAULTS.per_endpoint_daily_cap.drop_link;
    expect(cap).toBe(50);
    for (let i = 0; i < cap; i++) {
      const r = limiter.consumePostVerify({
        endpoint_id: 'endpoint-A',
        endpoint_kind: 'drop_link',
        now: NOW,
      });
      expect(r.ok).toBe(true);
    }
    const overflow = limiter.consumePostVerify({
      endpoint_id: 'endpoint-A',
      endpoint_kind: 'drop_link',
      now: NOW,
    });
    expect(overflow.ok).toBe(false);
  });

  it('reception_page daily cap is uncapped — POSITIVE_INFINITY', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const limiter = createReceptionRateLimiter({ db });
    // Run an absurdly-high count and expect every one to succeed at
    // the post-verify daily-cap check.
    for (let i = 0; i < 10_000; i++) {
      const r = limiter.consumePostVerify({
        endpoint_id: 'endpoint-page',
        endpoint_kind: 'reception_page',
        now: NOW,
      });
      expect(r.ok).toBe(true);
    }
  });

  it('window replenishment — overflow at NOW resets after window_ms', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const limiter = createReceptionRateLimiter({ db });
    const limit = RECEPTION_RATE_LIMIT_DEFAULTS.per_ip_global.max_requests;
    for (let i = 0; i < limit; i++) {
      limiter.consumePreVerify({ source_ip_hash: 'h', endpoint_kind: 'reception_page', now: NOW });
    }
    const overflow = limiter.consumePreVerify({
      source_ip_hash: 'h',
      endpoint_kind: 'reception_page',
      now: NOW,
    });
    expect(overflow.ok).toBe(false);
    const future = NOW + RECEPTION_RATE_LIMIT_DEFAULTS.per_ip_global.window_ms + 1;
    const fresh = limiter.consumePreVerify({
      source_ip_hash: 'h',
      endpoint_kind: 'reception_page',
      now: future,
    });
    expect(fresh.ok).toBe(true);
  });

  it('SQLite snapshot survives a simulated process restart', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const limiter1 = createReceptionRateLimiter({ db });
    for (let i = 0; i < 25; i++) {
      limiter1.consumePostVerify({
        endpoint_id: 'endpoint-cap',
        endpoint_kind: 'drop_link',
        now: NOW,
      });
    }
    limiter1.snapshot(NOW);
    const limiter2 = createReceptionRateLimiter({ db });
    limiter2.reload(NOW);
    const key = buildBucketKey({
      bucket_kind: 'per_endpoint_daily_cap',
      source_ip_hash: null,
      endpoint_id: 'endpoint-cap',
    });
    expect(limiter2.peek(key)?.count).toBe(25);
  });

  it('expired SQLite rows are not re-loaded', () => {
    const db = new Database(':memory:');
    ensureReceptionSchema(db);
    const limiter1 = createReceptionRateLimiter({ db });
    limiter1.consumePostVerify({
      endpoint_id: 'endpoint-old',
      endpoint_kind: 'drop_link',
      now: NOW,
    });
    limiter1.snapshot(NOW);
    const limiter2 = createReceptionRateLimiter({ db });
    const future = NOW + 25 * 60 * 60 * 1000;
    limiter2.reload(future);
    const key = buildBucketKey({
      bucket_kind: 'per_endpoint_daily_cap',
      source_ip_hash: null,
      endpoint_id: 'endpoint-old',
    });
    expect(limiter2.peek(key)).toBeUndefined();
  });
});
