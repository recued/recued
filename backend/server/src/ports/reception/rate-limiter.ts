/** D-149 P3 § Contract Tightening § Rate-limit substrate — hybrid
 *  in-memory + SQLite-snapshot per-IP / per-endpoint rate limiter.
 *
 *  In-memory token bucket is the hot path (sub-millisecond check on
 *  every Reception request); SQLite snapshot persists every 30s + on
 *  shutdown so long-window per-day caps survive process restarts.
 *
 *  Per Must Hold I-10: the listener calls `consume` BEFORE the HMAC
 *  verify so a flood of bearer-secret guesses doesn't burn CPU on
 *  HMAC compute. The `per_ip_global` + `per_endpoint_kind` buckets
 *  run pre-verify; the `per_endpoint_daily_cap` bucket runs AFTER
 *  verify (endpoint-id is not known pre-verify).
 *
 *  Spec: D-149 § Contract Tightening § Rate-limit substrate
 *  + `reception_rate_limiter` schema. */

import type Database from 'better-sqlite3';
import {
  RECEPTION_RATE_BUCKET_KIND_SET,
  RECEPTION_RATE_LIMIT_DEFAULTS,
  type ReceptionEndpointKind,
  type ReceptionRateBucketKind,
  type ReceptionRateLimitConfig,
  type ReceptionRateLimitDecision,
} from '@recued/contracts';

interface BucketState {
  count: number;
  window_start_at: number;
  window_end_at: number;
  last_request_at: number;
  exhausted_at: number | null;
}

interface SnapshotRow {
  bucket_key: string;
  bucket_kind: string;
  window_start_at: number;
  window_end_at: number;
  count: number;
  last_request_at: number;
  exhausted_at: number | null;
}

/** Bucket key construction — same string used by both in-memory map +
 *  SQLite snapshot. Stable across restarts so reload picks up the same
 *  bucket. */
export const buildBucketKey = (input: {
  bucket_kind: ReceptionRateBucketKind;
  source_ip_hash: string | null;
  endpoint_kind?: ReceptionEndpointKind;
  endpoint_id?: string;
}): string => {
  switch (input.bucket_kind) {
    case 'per_ip_global':
      return `per_ip_global:${input.source_ip_hash ?? '_anon'}`;
    case 'per_ip_per_endpoint':
      return `per_ip_per_endpoint:${input.source_ip_hash ?? '_anon'}:${input.endpoint_kind ?? '_unknown'}`;
    case 'per_endpoint_daily_cap':
      return `per_endpoint_daily_cap:${input.endpoint_id ?? '_unknown'}`;
  }
};

export interface ReceptionRateLimiter {
  /** Consume one token from the per-ip-global + per-endpoint-kind
   *  buckets. Returns `{ ok: true }` on accept; `{ ok: false, ... }`
   *  with the bucket-kind that triggered the deny on reject. Called
   *  BEFORE HMAC verify per § Must Hold I-10. */
  consumePreVerify(input: {
    source_ip_hash: string | null;
    endpoint_kind: ReceptionEndpointKind;
    now: number;
  }): ReceptionRateLimitDecision;
  /** Consume one token from the per-endpoint-daily-cap bucket. Called
   *  AFTER HMAC verify since the endpoint_id isn't known pre-verify. */
  consumePostVerify(input: {
    endpoint_id: string;
    endpoint_kind: ReceptionEndpointKind;
    now: number;
  }): ReceptionRateLimitDecision;
  /** Snapshot the current in-memory state to SQLite. Called by the 30s
   *  cadence + on shutdown. */
  snapshot(now: number): void;
  /** Reload state from SQLite. Called once at boot — restores the
   *  per-day caps so a process restart doesn't reset the visitor's
   *  daily counter. */
  reload(now: number): void;
  /** Diagnostic — read the current state of a single bucket. Returns
   *  undefined for unseen buckets. */
  peek(bucket_key: string): BucketState | undefined;
  /** Test helper — clear in-memory state. Does not touch the SQLite
   *  snapshot; tests pair this with a fresh `:memory:` db. */
  reset(): void;
}

export const createReceptionRateLimiter = (input: {
  db: Database.Database;
  config?: ReceptionRateLimitConfig;
  /** Hard cap on the in-memory bucket map (default 100k). Overridable so
   *  tests can drive eviction without minting 100k buckets. */
  maxMemoryBuckets?: number;
}): ReceptionRateLimiter => {
  const config = input.config ?? RECEPTION_RATE_LIMIT_DEFAULTS;
  const memory = new Map<string, BucketState>();

  // Hard cap on the in-memory bucket map. Without it an anonymous flood
  // that rotates source IPs (trivial over IPv6) mints a fresh bucket per
  // request and the map — plus the SQLite snapshot — grows without bound
  // (memory-exhaustion DoS). At ~120 bytes/bucket this caps the map near
  // ~12 MB. Eviction drops the oldest-INSERTED key (Map preserves
  // insertion order, so this is O(1)); an evicted-but-still-active bucket
  // simply re-mints on its next request — acceptable, since reaching the
  // cap already means the per-IP buckets are being churned by an attacker.
  const MAX_MEMORY_BUCKETS = input.maxMemoryBuckets ?? 100_000;
  const evictIfAtCap = (): void => {
    if (memory.size < MAX_MEMORY_BUCKETS) return;
    const oldest = memory.keys().next();
    if (!oldest.done) memory.delete(oldest.value);
  };

  const upsertSnapshotStmt = input.db.prepare(`
    INSERT INTO reception_rate_limiter (
      bucket_key, bucket_kind, window_start_at, window_end_at, count,
      last_request_at, exhausted_at
    ) VALUES (
      @bucket_key, @bucket_kind, @window_start_at, @window_end_at, @count,
      @last_request_at, @exhausted_at
    )
    ON CONFLICT(bucket_key) DO UPDATE SET
      bucket_kind     = excluded.bucket_kind,
      window_start_at = excluded.window_start_at,
      window_end_at   = excluded.window_end_at,
      count           = excluded.count,
      last_request_at = excluded.last_request_at,
      exhausted_at    = excluded.exhausted_at
  `);

  // Bound the boot reload too — a snapshot table that grew large before
  // this cap shipped must not recreate an over-cap map. Newest-active first.
  const reloadStmt = input.db.prepare(
    `SELECT * FROM reception_rate_limiter ORDER BY last_request_at DESC LIMIT @limit`,
  );

  // Housekeeping — drop persisted buckets whose window has already
  // closed so the snapshot table can't grow without bound alongside the
  // in-memory map.
  const deleteExpiredSnapshotStmt = input.db.prepare(
    `DELETE FROM reception_rate_limiter WHERE window_end_at <= @now`,
  );

  const tickBucket = (input: {
    bucket_key: string;
    bucket_kind: ReceptionRateBucketKind;
    window_ms: number;
    max_requests: number;
    now: number;
  }): ReceptionRateLimitDecision => {
    let state = memory.get(input.bucket_key);
    if (!state || state.window_end_at <= input.now) {
      // Window expired (or never seen) — start fresh. Only a brand-new
      // key can grow the map, so the cap-evict runs only then (resetting
      // an existing key's expired window reuses its slot).
      if (!state) evictIfAtCap();
      state = {
        count: 0,
        window_start_at: input.now,
        window_end_at: input.now + input.window_ms,
        last_request_at: input.now,
        exhausted_at: null,
      };
      memory.set(input.bucket_key, state);
    }
    if (state.count >= input.max_requests) {
      // Bucket exhausted within window — deny.
      if (state.exhausted_at === null) state.exhausted_at = input.now;
      return {
        ok: false,
        bucket_kind: input.bucket_kind,
        retry_after_at: state.window_end_at,
      };
    }
    state.count += 1;
    state.last_request_at = input.now;
    return { ok: true };
  };

  const tickDailyCap = (input: {
    endpoint_id: string;
    endpoint_kind: ReceptionEndpointKind;
    now: number;
  }): ReceptionRateLimitDecision => {
    const cap = config.per_endpoint_daily_cap[input.endpoint_kind];
    if (cap === Number.POSITIVE_INFINITY) return { ok: true };
    const window_ms = 24 * 60 * 60 * 1000;
    const bucket_key = buildBucketKey({
      bucket_kind: 'per_endpoint_daily_cap',
      source_ip_hash: null,
      endpoint_id: input.endpoint_id,
    });
    return tickBucket({
      bucket_key,
      bucket_kind: 'per_endpoint_daily_cap',
      window_ms,
      max_requests: cap,
      now: input.now,
    });
  };

  return {
    consumePreVerify({ source_ip_hash, endpoint_kind, now }) {
      // Global bucket first — broader gate; deny here protects every
      // endpoint kind in one go.
      const globalKey = buildBucketKey({
        bucket_kind: 'per_ip_global',
        source_ip_hash,
      });
      const globalDecision = tickBucket({
        bucket_key: globalKey,
        bucket_kind: 'per_ip_global',
        window_ms: config.per_ip_global.window_ms,
        max_requests: config.per_ip_global.max_requests,
        now,
      });
      if (!globalDecision.ok) return globalDecision;
      // Per-endpoint-kind bucket — tighter gate.
      const perKindKey = buildBucketKey({
        bucket_kind: 'per_ip_per_endpoint',
        source_ip_hash,
        endpoint_kind,
      });
      const perKind = config.per_endpoint_kind[endpoint_kind];
      return tickBucket({
        bucket_key: perKindKey,
        bucket_kind: 'per_ip_per_endpoint',
        window_ms: perKind.window_ms,
        max_requests: perKind.max_requests,
        now,
      });
    },

    consumePostVerify({ endpoint_id, endpoint_kind, now }) {
      return tickDailyCap({ endpoint_id, endpoint_kind, now });
    },

    snapshot(now) {
      // The 30s cadence doubles as the eviction sweep: a bucket whose
      // window has closed is dropped from memory (a later hit re-mints it)
      // rather than persisted, bounding the map between caps.
      for (const [bucket_key, state] of memory.entries()) {
        if (state.window_end_at <= now) {
          memory.delete(bucket_key);
          continue;
        }
        const [prefix] = bucket_key.split(':');
        const bucket_kind = (RECEPTION_RATE_BUCKET_KIND_SET.has(
          prefix as ReceptionRateBucketKind,
        )
          ? prefix
          : 'per_ip_global') as ReceptionRateBucketKind;
        upsertSnapshotStmt.run({
          bucket_key,
          bucket_kind,
          window_start_at: state.window_start_at,
          window_end_at: state.window_end_at,
          count: state.count,
          last_request_at: state.last_request_at,
          exhausted_at: state.exhausted_at,
        });
      }
      deleteExpiredSnapshotStmt.run({ now });
    },

    reload(now) {
      const rows = reloadStmt.all({ limit: MAX_MEMORY_BUCKETS }) as SnapshotRow[];
      for (const row of rows) {
        if (row.window_end_at <= now) continue; // window already expired
        memory.set(row.bucket_key, {
          count: row.count,
          window_start_at: row.window_start_at,
          window_end_at: row.window_end_at,
          last_request_at: row.last_request_at,
          exhausted_at: row.exhausted_at,
        });
      }
    },

    peek(bucket_key) {
      return memory.get(bucket_key);
    },

    reset() {
      memory.clear();
    },
  };
};
