/** D-201 Slice 5B2B2B2B — bounded trusted clock health.
 *
 * Timestamp freshness cannot be authorized by Date.now() alone. This authority
 * probes one operator-pinned HTTPS origin with a random cache-busting query,
 * derives a bounded current-time estimate from its authenticated Date header,
 * and keeps that evidence only against a monotonic clock. Callers receive the
 * authority-derived time, not a boolean that would let them fall back to an
 * unverified local wall clock.
 */

import { randomBytes } from 'node:crypto';

export const WEBHOOK_CLOCK_MAX_ERROR_MS = 5_000;
export const WEBHOOK_CLOCK_MAX_ROUND_TRIP_MS = 2_000;
export const WEBHOOK_CLOCK_EVIDENCE_TTL_MS = 60_000;
export const WEBHOOK_CLOCK_PROBE_TIMEOUT_MS = 3_000;
export const WEBHOOK_CLOCK_FAILURE_RETRY_MS = 5_000;
/** Conservative projection allowance: 1% over the short evidence lifetime. */
export const WEBHOOK_CLOCK_MAX_MONOTONIC_DRIFT_PPM = 10_000;

const MAX_AUTHORITY_URL_BYTES = 2_048;
const PROBE_NONCE_RE = /^[0-9a-f]{32}$/;
const PROBE_NONCE_HEADER = 'x-recued-clock-nonce';
const HTTP_DATE_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;

export type WebhookClockHealthFailureReason =
  | 'probe_unavailable'
  | 'invalid_response'
  | 'round_trip_exceeded'
  | 'clock_error_exceeded';

export type WebhookClockHealthCheck =
  | {
      healthy: true;
      /** Fresh authority-derived epoch time for one immediate freshness check. */
      trusted_now_ms: number;
      /** Conservative upper bound on the local wall clock's current error. */
      maximum_error_ms: number;
      /** Authority-derived epoch time at which the backing probe completed. */
      checked_at: number;
    }
  | {
      healthy: false;
      reason: WebhookClockHealthFailureReason;
    };

export interface WebhookClockHealthAuthority {
  check(): Promise<WebhookClockHealthCheck>;
}

/** Resolve one immediately usable authority-derived epoch. Timestamped
 * profile adapters share this strict evidence check so a new vendor cannot
 * accidentally fall back to the process wall clock or accept stale evidence.
 */
export const readTrustedWebhookClockNow = async (
  authority: WebhookClockHealthAuthority,
): Promise<number | null> => {
  try {
    const health = await authority.check();
    return health.healthy
      && Number.isSafeInteger(health.trusted_now_ms)
      && health.trusted_now_ms >= 1_000
      && Number.isSafeInteger(health.maximum_error_ms)
      && health.maximum_error_ms >= 0
      && health.maximum_error_ms <= WEBHOOK_CLOCK_MAX_ERROR_MS
      && Number.isSafeInteger(health.checked_at)
      && health.checked_at >= 1_000
      && health.trusted_now_ms >= health.checked_at
      && health.trusted_now_ms - health.checked_at
        <= WEBHOOK_CLOCK_EVIDENCE_TTL_MS
      ? health.trusted_now_ms
      : null;
  } catch {
    return null;
  }
};

export interface WebhookClockHealthAuthorityOptions {
  authorityUrl: string;
  fetchImpl?: typeof fetch;
  wallNow?: () => number;
  monotonicNow?: () => number;
  newProbeNonce?: () => string;
  maxClockErrorMs?: number;
  maxRoundTripMs?: number;
  evidenceTtlMs?: number;
  probeTimeoutMs?: number;
  failureRetryMs?: number;
}

interface ClockEvidence {
  monotonic_at: number;
  trusted_at: number;
  uncertainty_ms: number;
  checked_at: number;
}

interface FailedProbe {
  monotonic_at: number;
  reason: WebhookClockHealthFailureReason;
}

interface ClockSample {
  monotonic: number;
  wall: number;
  sampling_uncertainty_ms: number;
}

const monotonicNow = (): number =>
  Number(process.hrtime.bigint() / 1_000_000n);

const positiveBound = (
  value: number,
  name: string,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`webhook clock health: ${name} is invalid`);
  }
  return value;
};

const safeClockRead = (clock: () => number): number | null => {
  try {
    const value = clock();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
};

const readClockSample = (
  readMonotonic: () => number,
  readWall: () => number,
): ClockSample | null => {
  const before = safeClockRead(readMonotonic);
  const wall = safeClockRead(readWall);
  const after = safeClockRead(readMonotonic);
  if (before === null || wall === null || after === null || after < before) {
    return null;
  }
  return {
    monotonic: after,
    wall,
    // The wall read occurred somewhere inside this monotonic interval. Carry
    // the whole interval so scheduling delay cannot make the bound optimistic.
    sampling_uncertainty_ms: after - before,
  };
};

const strictHttpDate = (value: string | null): number | null => {
  if (value === null || !HTTP_DATE_RE.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return new Date(parsed).toUTCString() === value ? parsed : null;
};

const projectedMonotonicDrift = (elapsedMs: number): number =>
  Math.ceil(
    elapsedMs * WEBHOOK_CLOCK_MAX_MONOTONIC_DRIFT_PPM / 1_000_000,
  );

const discardResponseBody = (response: Response): void => {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Clock evidence never depends on response content.
  }
};

/** Resolve the boot-pinned trust anchor. There is deliberately no default:
 * enabling an outbound time dependency is an operator decision. */
export const resolveWebhookClockAuthorityUrl = (
  raw: string | undefined,
): string | null => {
  if (raw === undefined) return null;
  const candidate = raw.trim();
  if (candidate.length === 0
    || Buffer.byteLength(candidate, 'utf8') > MAX_AUTHORITY_URL_BYTES
    || candidate.includes('?')
    || candidate.includes('#')
    || candidate.includes('\\')) {
    return null;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:'
      || parsed.hostname.length === 0
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.search.length > 0
      || parsed.hash.length > 0) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
};

const unhealthy = (
  reason: WebhookClockHealthFailureReason,
): WebhookClockHealthCheck => ({ healthy: false, reason });

export const createWebhookClockHealthAuthority = (
  options: WebhookClockHealthAuthorityOptions,
): WebhookClockHealthAuthority => {
  const authorityUrl = resolveWebhookClockAuthorityUrl(options.authorityUrl);
  if (authorityUrl === null) {
    throw new Error('webhook clock health: authority URL is invalid');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const wallNow = options.wallNow ?? Date.now;
  const readMonotonic = options.monotonicNow ?? monotonicNow;
  const newProbeNonce = options.newProbeNonce
    ?? (() => randomBytes(16).toString('hex'));
  const maxClockErrorMs = positiveBound(
    options.maxClockErrorMs ?? WEBHOOK_CLOCK_MAX_ERROR_MS,
    'maxClockErrorMs',
    60_000,
  );
  const maxRoundTripMs = positiveBound(
    options.maxRoundTripMs ?? WEBHOOK_CLOCK_MAX_ROUND_TRIP_MS,
    'maxRoundTripMs',
    60_000,
  );
  const evidenceTtlMs = positiveBound(
    options.evidenceTtlMs ?? WEBHOOK_CLOCK_EVIDENCE_TTL_MS,
    'evidenceTtlMs',
    10 * 60_000,
  );
  const probeTimeoutMs = positiveBound(
    options.probeTimeoutMs ?? WEBHOOK_CLOCK_PROBE_TIMEOUT_MS,
    'probeTimeoutMs',
    60_000,
  );
  const failureRetryMs = positiveBound(
    options.failureRetryMs ?? WEBHOOK_CLOCK_FAILURE_RETRY_MS,
    'failureRetryMs',
    60_000,
  );

  let evidence: ClockEvidence | null = null;
  let lastFailure: FailedProbe | null = null;
  let inFlight: Promise<WebhookClockHealthCheck> | null = null;
  // Distinct from the caller-visible probe race: an injected or broken
  // transport can ignore AbortSignal. Keep that request pinned until it truly
  // settles so a timed-out request can never be followed by an unbounded train
  // of still-live probes.
  let transportInFlight: Promise<void> | null = null;

  const fromEvidence = (
    current: ClockEvidence,
  ): WebhookClockHealthCheck | null => {
    const sample = readClockSample(readMonotonic, wallNow);
    if (sample === null) return null;
    const elapsed = sample.monotonic - current.monotonic_at;
    if (!Number.isSafeInteger(elapsed)
      || elapsed < 0
      || elapsed > evidenceTtlMs) {
      return null;
    }
    const trustedNow = current.trusted_at + elapsed;
    if (!Number.isSafeInteger(trustedNow) || trustedNow < 0) return null;
    const maximumError = Math.ceil(
      Math.abs(sample.wall - trustedNow)
        + current.uncertainty_ms
        + projectedMonotonicDrift(elapsed)
        + sample.sampling_uncertainty_ms,
    );
    if (!Number.isSafeInteger(maximumError)
      || maximumError > maxClockErrorMs) {
      return null;
    }
    return {
      healthy: true,
      trusted_now_ms: trustedNow,
      maximum_error_ms: maximumError,
      checked_at: current.checked_at,
    };
  };

  const runProbe = async (): Promise<WebhookClockHealthCheck> => {
    const startedMonotonic = safeClockRead(readMonotonic);
    if (startedMonotonic === null) return unhealthy('probe_unavailable');
    let nonce: string;
    try {
      nonce = newProbeNonce();
    } catch {
      return unhealthy('probe_unavailable');
    }
    if (!PROBE_NONCE_RE.test(nonce)) return unhealthy('probe_unavailable');
    const requestUrl = new URL(authorityUrl);
    requestUrl.searchParams.set('_recued_clock_probe', nonce);
    const controller = new AbortController();
    let requestTimedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        requestTimedOut = true;
        controller.abort();
        reject(new Error('webhook clock probe timed out'));
      }, probeTimeoutMs);
      if (typeof timeout.unref === 'function') timeout.unref();
    });

    let response: Response;
    const request = Promise.resolve().then(() => fetchImpl(requestUrl, {
      method: 'HEAD',
      headers: {
        accept: '*/*',
        'cache-control': 'no-cache, no-store',
        pragma: 'no-cache',
        [PROBE_NONCE_HEADER]: nonce,
      },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })).then((lateResponse) => {
      if (requestTimedOut) discardResponseBody(lateResponse);
      return lateResponse;
    });
    let trackedTransport!: Promise<void>;
    trackedTransport = request.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (transportInFlight === trackedTransport) transportInFlight = null;
    });
    transportInFlight = trackedTransport;
    try {
      response = await Promise.race([
        request,
        timeoutFailure,
      ]);
    } catch {
      const failedAt = safeClockRead(readMonotonic) ?? startedMonotonic;
      lastFailure = {
        monotonic_at: failedAt,
        reason: 'probe_unavailable',
      };
      return unhealthy('probe_unavailable');
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    const finishedSample = readClockSample(readMonotonic, wallNow);
    let remoteDate: number | null = null;
    try {
      if (response === null
        || typeof response !== 'object'
        || !Number.isSafeInteger(response.status)
        || response.status < 200
        || response.status > 299
        || response.redirected
        || (response.url.length > 0 && response.url !== requestUrl.href)) {
        throw new Error('invalid webhook clock response');
      }
      if (response.headers.get(PROBE_NONCE_HEADER) !== nonce) {
        throw new Error('webhook clock nonce was not echoed');
      }
      const age = response.headers.get('age');
      if (age !== null && age !== '0') {
        throw new Error('cached webhook clock response');
      }
      remoteDate = strictHttpDate(response.headers.get('date'));
    } catch {
      remoteDate = null;
    } finally {
      discardResponseBody(response);
    }
    if (finishedSample === null || remoteDate === null) {
      const failedAt = finishedSample?.monotonic ?? startedMonotonic;
      lastFailure = { monotonic_at: failedAt, reason: 'invalid_response' };
      return unhealthy('invalid_response');
    }
    const finishedMonotonic = finishedSample.monotonic;
    const roundTrip = finishedMonotonic - startedMonotonic;
    const roundTripDrift = Number.isSafeInteger(roundTrip) && roundTrip >= 0
      ? projectedMonotonicDrift(roundTrip)
      : 0;
    if (!Number.isSafeInteger(roundTrip)
      || roundTrip < 0
      || roundTrip + roundTripDrift > maxRoundTripMs) {
      lastFailure = {
        monotonic_at: finishedMonotonic,
        reason: 'round_trip_exceeded',
      };
      return unhealthy('round_trip_exceeded');
    }

    // HTTP-date has whole-second precision. At probe completion, the remote
    // current time lies inside [Date, Date + 999ms + RTT]. Use that interval's
    // midpoint and carry its full half-width as uncertainty.
    const uncertainty = Math.ceil(500 + roundTrip / 2 + roundTripDrift);
    const trustedAt = Math.round(remoteDate + 500 + roundTrip / 2);
    const maximumError = Math.ceil(
      Math.abs(finishedSample.wall - trustedAt)
        + uncertainty
        + finishedSample.sampling_uncertainty_ms,
    );
    if (!Number.isSafeInteger(trustedAt)
      || trustedAt < 0
      || !Number.isSafeInteger(maximumError)
      || maximumError > maxClockErrorMs) {
      lastFailure = {
        monotonic_at: finishedMonotonic,
        reason: 'clock_error_exceeded',
      };
      return unhealthy('clock_error_exceeded');
    }
    evidence = {
      monotonic_at: finishedMonotonic,
      trusted_at: trustedAt,
      uncertainty_ms: uncertainty,
      checked_at: trustedAt,
    };
    lastFailure = null;
    return {
      healthy: true,
      trusted_now_ms: trustedAt,
      maximum_error_ms: maximumError,
      checked_at: trustedAt,
    };
  };

  return Object.freeze({
    async check(): Promise<WebhookClockHealthCheck> {
      if (evidence !== null) {
        const cached = fromEvidence(evidence);
        if (cached !== null) return cached;
        evidence = null;
      }
      if (inFlight !== null) return inFlight;
      if (transportInFlight !== null) return unhealthy('probe_unavailable');
      const currentMonotonic = safeClockRead(readMonotonic);
      if (lastFailure !== null
        && currentMonotonic !== null
        && currentMonotonic >= lastFailure.monotonic_at
        && currentMonotonic - lastFailure.monotonic_at < failureRetryMs) {
        return unhealthy(lastFailure.reason);
      }
      const probe = runProbe();
      inFlight = probe;
      try {
        const result = await probe;
        if (!result.healthy && lastFailure === null) {
          const failedAt = safeClockRead(readMonotonic);
          if (failedAt !== null) {
            lastFailure = {
              monotonic_at: failedAt,
              reason: result.reason,
            };
          }
        }
        return result;
      } finally {
        if (inFlight === probe) inFlight = null;
      }
    },
  });
};
