/** D-149 P3 § Contract Tightening § Rate-limit substrate — reception
 *  per-IP + per-endpoint-kind + per-endpoint-daily rate-limit config.
 *
 *  Three bucket kinds:
 *
 *    - **per_ip_global** — global per-source-IP-hash bucket across every
 *      reception endpoint. Default 60 req / 60s window. Prevents a
 *      bot-net from hammering many endpoints without each one triggering
 *      its per-kind cap.
 *    - **per_endpoint_kind** — per-kind window. `intake_form` /
 *      `drop_link` / `approval_link` are tighter (10 / 5 / 5 per hour);
 *      `reception_page` / `scheduling_link` / `status_link` are looser
 *      (60 / 30 / 60 per minute) since the surfaces are read-mostly +
 *      `status_link` accommodates 60s auto-refresh.
 *    - **per_endpoint_daily_cap** — per-endpoint absolute daily ceiling.
 *      `reception_page` is uncapped (Number.POSITIVE_INFINITY); link-style
 *      kinds carry 50-5,000 daily ceilings sized to the kind's threat
 *      model (drop_link 50/day; status_link 5,000/day to accommodate
 *      polling visitors).
 *
 *  Per Must Hold I-10 (rate-limit BEFORE HMAC compute): the listener's
 *  request-path runs `per_ip_global` + `per_endpoint_kind` checks BEFORE
 *  the HMAC verify so a flood of bearer-secret guesses doesn't burn
 *  CPU. Per Must Hold I-12b: per-endpoint daily caps run AFTER token
 *  verification but before the per-kind handler dispatches (the cap is
 *  endpoint-scoped, so it can only fire once a valid token is presented).
 *
 *  Storage: hybrid in-memory primary (sub-millisecond check on the
 *  request hot path) + 30s SQLite snapshot to `reception_rate_limiter`
 *  for long-window per-day cap survivability across process restarts.
 *  P3 lands both the in-memory token-bucket primary + the persistence
 *  cadence + boot-time reload.
 *
 *  Spec: docs/d-149-spec.md § Contract Tightening § Rate-limit substrate. */

import type { ReceptionEndpointKind } from './reception.js';

// ────────────────────────────────────────────────────────────────
// Bucket-kind closed list
// ────────────────────────────────────────────────────────────────

export type ReceptionRateBucketKind =
  | 'per_ip_global'
  | 'per_ip_per_endpoint'
  | 'per_endpoint_daily_cap';

export const RECEPTION_RATE_BUCKET_KINDS: ReadonlyArray<ReceptionRateBucketKind> = [
  'per_ip_global',
  'per_ip_per_endpoint',
  'per_endpoint_daily_cap',
] as const;

export const RECEPTION_RATE_BUCKET_KIND_SET: ReadonlySet<ReceptionRateBucketKind> = new Set(
  RECEPTION_RATE_BUCKET_KINDS,
);

// ────────────────────────────────────────────────────────────────
// Config defaults
// ────────────────────────────────────────────────────────────────

export interface ReceptionRateLimitWindow {
  /** Window length in ms. */
  readonly window_ms: number;
  /** Max requests permitted within `window_ms`. */
  readonly max_requests: number;
}

export interface ReceptionRateLimitConfig {
  /** Global per-IP-hash bucket across every endpoint. */
  readonly per_ip_global: ReceptionRateLimitWindow;
  /** Per-IP-hash per-endpoint-kind bucket. */
  readonly per_endpoint_kind: Readonly<Record<ReceptionEndpointKind, ReceptionRateLimitWindow>>;
  /** Per-endpoint absolute daily cap. `POSITIVE_INFINITY` ⇒ uncapped. */
  readonly per_endpoint_daily_cap: Readonly<Record<ReceptionEndpointKind, number>>;
}

/** Spec § Contract Tightening § Rate-limit substrate — defaults
 *  baseline. Mary can override per-endpoint via the Settings → Server
 *  → Reception → per-endpoint limits page (P3 lands the rpc surface;
 *  Settings UX scaffolding at P3 — full UX completes at P10). */
export const RECEPTION_RATE_LIMIT_DEFAULTS: ReceptionRateLimitConfig = {
  per_ip_global: { window_ms: 60_000, max_requests: 60 },
  per_endpoint_kind: {
    reception_page: { window_ms: 60_000, max_requests: 60 },
    scheduling_link: { window_ms: 60_000, max_requests: 30 },
    intake_form: { window_ms: 3_600_000, max_requests: 10 },
    drop_link: { window_ms: 3_600_000, max_requests: 5 },
    approval_link: { window_ms: 3_600_000, max_requests: 5 },
    status_link: { window_ms: 60_000, max_requests: 60 },
  },
  per_endpoint_daily_cap: {
    reception_page: Number.POSITIVE_INFINITY,
    scheduling_link: 100,
    intake_form: 1_000,
    drop_link: 50,
    approval_link: 100,
    status_link: 5_000,
  },
} as const;

// ────────────────────────────────────────────────────────────────
// Decision shape
// ────────────────────────────────────────────────────────────────

/** Per-request rate-limit decision the listener consumes. Captured in
 *  `public_endpoint_access_log` when `decision: 'rate_limited'` so
 *  operators can correlate denied requests with the exhausted bucket. */
export type ReceptionRateLimitDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly bucket_kind: ReceptionRateBucketKind;
      /** Unix-ms; informs `Retry-After` header on 429 response. */
      readonly retry_after_at: number;
    };
