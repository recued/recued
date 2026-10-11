/** D-118 — the service vocabulary that outlived the service installer.
 *
 *  D-118 shipped a service platform (`data.service.*`, the
 *  `collection.service.*` rpcs): an installer, enroll flow and supervisor for
 *  `kind: service` templates. Nothing could reach it, since no template was ever
 *  registered, and it was retired on 2026-10-10 (D-321 § 5.4). What is left here
 *  is what the cli-daemon supervision (D-170) still shares with it: the closed
 *  check-kind and restart-policy registries, the crash ceiling and backoff, the
 *  live-state and health shapes, and the check result.
 *
 *  The closed registries are a load-bearing security boundary: adding a kind is
 *  a Recued-core code change, never a pack change.
 */

// ────────────────────────────────────────────────────────────────
// Closed typed registries
// ────────────────────────────────────────────────────────────────

/** Check kinds for a supervised daemon's health check
 *  (`collections/service/checkers/`). Closed registry; the dispatcher
 *  refuses any unknown kind. */
export const SERVICE_CHECK_KINDS = [
  'binary_in_path',
  'file_exists',
  'http_ok',
  'tcp_open',
  'pid_file',
  'exec_ok',
] as const;
export type ServiceCheckKind = (typeof SERVICE_CHECK_KINDS)[number];

/** One closed-registry service check declaration. Individual checker modules
 * validate the parameters for their own `kind`; this shared carrier keeps
 * callers on the D-118 vocabulary without duplicating that parameter union. */
export type ServiceCheckSpec = {
  kind: ServiceCheckKind;
} & Record<string, unknown>;

/** Restart policies for a supervised daemon. `'on-crash'` is the
 *  default and the common choice. */
export const SERVICE_RESTART_POLICIES = [
  'never',
  'on-crash',
  'always',
] as const;
export type ServiceRestartPolicy = (typeof SERVICE_RESTART_POLICIES)[number];

// ────────────────────────────────────────────────────────────────
// Defaults / floors
// ────────────────────────────────────────────────────────────────

/** Floor for a health check's `interval_ms`. A pack that asks for
 *  faster polling is clamped — health is meant for status, not
 *  liveness probing. */
export const SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR = 10_000;

/** Consecutive crashes ceiling — past this, the supervisor stops
 *  restarting and flips the daemon to `permanently_crashed`, until
 *  the owner clears it. */
export const SERVICE_CONSECUTIVE_CRASHES_MAX = 5;

/** Restart backoff schedule indexed by `consecutive_crashes - 1`.
 *  1 s → 5 s → 30 s → 2 min → 10 min, then ceiling fires. */
export const SERVICE_RESTART_BACKOFF_MS = [
  1_000,
  5_000,
  30_000,
  120_000,
  600_000,
] as const;

// ────────────────────────────────────────────────────────────────
// Runtime state shapes
// ────────────────────────────────────────────────────────────────

/** Live execution state of a supervised daemon. */
export type ServiceState =
  | 'running'
  | 'stopped'
  | 'crashed'
  | 'permanently_crashed'
  | 'unknown';

/** Result of the most recent health-check evaluation. `'unknown'`
 *  before the first tick, or when the daemon declares no check. */
export type ServiceHealthState = 'healthy' | 'unhealthy' | 'unknown';

// ────────────────────────────────────────────────────────────────
// Check result
// ────────────────────────────────────────────────────────────────

/** Result of one structured check. */
export interface ServiceCheckResult {
  passed: boolean;
  /** Optional human-readable detail — surfaced in audit + UI. */
  detail?: string;
}
