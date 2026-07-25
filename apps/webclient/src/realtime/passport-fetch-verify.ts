/** D-148 § A.6.5 + § A.9 — webclient passport-fetch verify orchestrator.
 *
 *  Composes the slice-115 verify primitives (`verifyPassportCert-
 *  Attestation` + `applyObservedCertFingerprintToState`) with the rpc
 *  surface (`passport.fetch`) + the local-store persist + the cert-pin
 *  state watcher + the pair-required local trigger. Wired by the
 *  bootstrap to fire on every successful WS reconnect.
 *
 *  Closes the WS-handshake side of the two-pin overlap protocol:
 *
 *    1. Calls `passport.fetch` on the typed rpc conn.
 *    2. Reads the current `cert_pin_state` from local-store.
 *    3. Threads the response through `verifyPassportCertAttestation`
 *       against the pinned `server_public_key`.
 *    4. Dispatches on the unified result:
 *       - `outcome === 'idempotent'`: no-op (verify primitive returned
 *         the input ref by reference — caller skips the persist + the
 *         watcher's ref-equality short-circuit fires).
 *       - `outcome === 'seeded' | 'promoted'`: persist + fire the
 *         watcher's `notify()` so the Settings → Server cert-pin-stale
 *         panel hides at the next render tick.
 *       - `reason === 'observed_fingerprint_unknown'`: fire the local
 *         `onPairRequired` trigger so the caller surfaces the re-pair
 *         banner (MITM-class signal; the channel may be compromised
 *         + the user must re-pair through the admin-token-gated flow,
 *         spec § A.6.5 line 918).
 *       - any other rejection (`signature_invalid` / `passport_stale`
 *         / `identity_key_mismatch` / `cert_fingerprint_missing`):
 *         route to the `onError` failure sink with `stage: 'verify'`.
 *
 *  ── Key design decisions (READ before touching) ─────────────────────
 *
 *  DD#1 — Local pair-required trigger, not synthesized broadcast.
 *  Pre-design considered dispatching a fake `pair_required` event
 *  into the broadcast subscriber so the existing `PairRequiredHandler`
 *  picks it up uniformly. Rejected: `pair_required` is a contract
 *  for server-emitted broadcasts (closed-list reasons:
 *  `server_identity_rotated | compromise | manual`), and the cert-
 *  mismatch case is a CLIENT-side observation. Synthesizing a
 *  broadcast would couple the local cert-mismatch surface to the
 *  bus's lifecycle (subscribe-after-connect timing, cursor replay,
 *  etc.) for no benefit. The caller's `onPairRequired` callback owns
 *  the local-trigger UX; today the bootstrap wires this to a future
 *  re-pair flow (or a no-op telemetry sink) without forcing the
 *  PairRequiredHandler to expand its contract.
 *
 *  DD#2 — `passport.fetch` returns `not_configured` until the server
 *  composes the passport-block-providers substrate. The orchestrator
 *  treats `not_configured` (and any other rpc rejection) as a
 *  recoverable error routed to `onError` with `stage: 'rpc'` —
 *  the WS itself stays connected, the cert-pin-stale panel keeps
 *  rendering, the user can still rotate manually. The verify path
 *  graduates to "real defense" only once the providers wire up;
 *  until then it's a no-op + telemetry hook.
 *
 *  DD#3 — Single-fire per call. The orchestrator is fire-and-forget
 *  from the bootstrap's perspective: a slow rpc + verify pipeline
 *  must not back-pressure the WS reconnect loop. The bootstrap calls
 *  `runPassportFetchVerify(...)` on every state transition to
 *  `connected`; concurrent invocations are tolerated (one tab opens
 *  a reconnect storm) — the last persist wins, which is the correct
 *  semantics since the server's vouched cert is the same per
 *  reconnect attempt.
 *
 *  DD#4 — Idempotent outcome SKIPS the persist + the watcher notify
 *  by design. The verify primitive returns the same `current` ref on
 *  idempotent, so even if the caller did persist + notify, the
 *  watcher's reference-equality short-circuit would no-op. The
 *  orchestrator just skips the round trips to keep the trace clean.
 */

import type {
  Conn,
  ServerRpcRegistry,
  WebclientCertPinState,
} from '@recued/contracts';

import { verifyPassportCertAttestation, type VerifyPassportCertAttestationOptions } from './cert-pin.js';
import type { CertPinStateWatcher } from './cert-pin-state-watcher.js';
import type { WebclientLocalStore } from '../storage/local-store.js';

/** Closed list of failure stages reported through `onError`. */
export type PassportFetchVerifyFailureStage =
  | 'rpc'        // passport.fetch rpc rejection (network / not_configured / forbidden / timeout)
  | 'read'       // localStore.get('cert_pin_state') threw
  | 'verify'     // verify primitive rejected with a non-MITM reason
  | 'persist';   // localStore.set('cert_pin_state', next) threw

export interface PassportFetchVerifyFailureContext {
  stage: PassportFetchVerifyFailureStage;
  /** The verify-stage rejection reason when stage === 'verify'.
   *  Undefined for every other stage. Carries the closed-list
   *  `signature_invalid | passport_stale | identity_key_mismatch |
   *  cert_fingerprint_missing` (the MITM-class
   *  `observed_fingerprint_unknown` routes to `onPairRequired`
   *  instead). */
  verify_reason?:
    | 'signature_invalid'
    | 'passport_stale'
    | 'identity_key_mismatch'
    | 'cert_fingerprint_missing';
}

/** Context handed to `onPairRequired`. Carries the observed
 *  fingerprint so a future re-pair surface can render
 *  "Cert fingerprint claimed by server: <hash>" copy + the consumer
 *  can correlate against an out-of-band cert audit. */
export interface PassportFetchVerifyPairRequiredContext {
  cert_fingerprint_observed: string;
}

export interface RunPassportFetchVerifyOptions {
  /** Typed rpc conn — the bootstrap-owned `WebclientRpcConn.call`.
   *  Captured by reference so a future rotation of the WS underneath
   *  doesn't require re-binding the orchestrator. */
  conn: Conn<ServerRpcRegistry>;
  /** Shared local-store. Read for `cert_pin_state` + written on
   *  promote / seed outcomes. */
  localStore: WebclientLocalStore;
  /** The pinned `server_public_key` (base64 SPKI DER). Bootstrap
   *  hydrates this once from `localStore.get('server_public_key')`;
   *  captured by closure so the orchestrator doesn't re-read on every
   *  call. */
  pinnedServerPublicKey: string;
  /** Optional cert-pin state watcher. When present + persist succeeds,
   *  the orchestrator fires `watcher.notify(next)` so the Settings →
   *  Server cert-pin-stale panel re-renders synchronously without
   *  waiting for the 60s polling tick. Absent → the panel still
   *  re-renders on the next tick; the optional wire is a render
   *  freshness optimization. */
  certPinWatcher?: CertPinStateWatcher;
  /** Clock seam (tests). Defaults to `Date.now`. Threads through to
   *  the verify primitive's freshness gate. */
  now?: () => number;
  /** Override the verify primitive's freshness window. Tests with
   *  stable fixtures pass a wider window so the FIXED_NOW seam stays
   *  stable across recordings; production keeps the defaults. */
  verifyOptions?: VerifyPassportCertAttestationOptions;
  /** Best-effort failure sink. Defaults to no-op — a transient rpc
   *  failure or verify rejection leaves the pin state intact + lets
   *  the next reconnect re-attempt. */
  onError?: (err: Error, context: PassportFetchVerifyFailureContext) => void;
  /** Local pair-required trigger for the MITM-class signal. Fires only
   *  when the verify path rejects with `observed_fingerprint_unknown`
   *  (cert matches neither pinned current nor staged next AND a prior
   *  pin exists). The caller surfaces the re-pair banner or otherwise
   *  forces the admin-token-gated re-pair flow. Defaults to no-op. */
  onPairRequired?: (context: PassportFetchVerifyPairRequiredContext) => void;
}

/** One pass of the fetch-verify-persist-trigger pipeline. Resolves
 *  after the persist completes (or the call short-circuits on
 *  idempotent / verify rejection). Never throws — every error path
 *  routes through `onError` so the caller (bootstrap) can fire-and-
 *  forget without a `.catch()` handler. */
export const runPassportFetchVerify = async (
  options: RunPassportFetchVerifyOptions,
): Promise<void> => {
  const {
    conn,
    localStore,
    pinnedServerPublicKey,
    certPinWatcher,
    verifyOptions,
    onError,
    onPairRequired,
  } = options;
  const clock = options.now ?? Date.now;

  // 1. passport.fetch rpc round-trip.
  let response: { passport: import('@recued/contracts').ServerPassportProjection };
  try {
    response = await conn('passport.fetch', undefined);
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    if (onError) {
      try {
        onError(wrapped, { stage: 'rpc' });
      } catch {
        /* failure-report sink must never re-enter the orchestrator */
      }
    }
    return;
  }

  // 2. Read current pin state. A first-time webclient may have no pin
  //    state yet (cold-boot before the first cert.rotation_notice + no
  //    pair-time pin acquisition); the verify primitive's seed branch
  //    handles null + the empty-string sentinel uniformly.
  let current: WebclientCertPinState | null;
  try {
    current = await localStore.get('cert_pin_state');
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    if (onError) {
      try {
        onError(wrapped, { stage: 'read' });
      } catch {
        /* failure-report sink must never re-enter the orchestrator */
      }
    }
    return;
  }

  // 3. Verify primitive. Composes Ed25519 verify + freshness gate +
  //    identity-key-replay defense + cert-fingerprint presence gate,
  //    then delegates to the seed / promote / idempotent / unknown
  //    transition.
  //
  //    Codex 2026-05-17 P2 fold (slice 116b round 3) — wrap the
  //    verify call in try/catch. The primitive's contract is to
  //    return a typed `PassportCertVerifyResult` for every defined
  //    rejection, but a sufficiently malformed passport payload can
  //    throw out of `canonicalPassportSigningPayload` (non-finite
  //    numbers, bigints, missing identity block accessed before the
  //    typed rejection runs) BEFORE the function reaches its
  //    rejection-shaped return. Since the orchestrator is called
  //    fire-and-forget from the bootstrap (`void runPassportFetch-
  //    Verify(...)`), an uncaught throw here would surface as an
  //    unhandled promise rejection in the browser console instead
  //    of the documented `stage: 'verify'` failure path.
  let result: Awaited<ReturnType<typeof verifyPassportCertAttestation>>;
  try {
    result = await verifyPassportCertAttestation(
      response.passport,
      pinnedServerPublicKey,
      current,
      clock(),
      verifyOptions,
    );
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    if (onError) {
      try {
        onError(wrapped, { stage: 'verify' });
      } catch {
        /* failure-report sink must never re-enter the orchestrator */
      }
    }
    return;
  }

  // 4. Dispatch on the unified result.
  if (!result.ok) {
    if (result.reason === 'observed_fingerprint_unknown') {
      // MITM-class signal — local pair-required trigger (DD#1).
      if (onPairRequired) {
        try {
          onPairRequired({
            cert_fingerprint_observed: response.passport.network.cert_fingerprint,
          });
        } catch {
          /* trigger sink must never re-enter the orchestrator */
        }
      }
      return;
    }
    // Verify-stage rejection (signature_invalid / passport_stale /
    // identity_key_mismatch / cert_fingerprint_missing). Routes to the
    // failure sink; the pin state stays intact.
    if (onError) {
      try {
        onError(
          new Error(`passport-fetch verify rejected: ${result.reason}`),
          { stage: 'verify', verify_reason: result.reason },
        );
      } catch {
        /* failure-report sink must never re-enter the orchestrator */
      }
    }
    return;
  }

  // DD#4 — idempotent outcome short-circuits both persist + notify.
  // The verify primitive returned the input ref by reference so even
  // a redundant persist would be a no-op against the watcher's
  // reference-equality guard. Skipping keeps the trace clean.
  if (result.outcome === 'idempotent') return;

  // 5. Re-read just before write + bail if the snapshot moved (Codex
  //    2026-05-17 P2 fold, slice 116 — concurrent-persist defense).
  //    The cert-pin handler serializes its own writes through an
  //    internal promise chain; the verify orchestrator is decoupled
  //    + can race the handler if a `cert.rotation_notice` or
  //    `cert.rotation_reverted` lands between our read in step 2 and
  //    our write below. Without this CAS check, the late passport
  //    persist would resurrect the promoted cert + drop the newer
  //    transition (e.g., a revert that ran while passport.fetch was
  //    in flight).
  //
  //    Strategy: re-read; if the snapshot now equals the original
  //    `current` we read in step 2 (by structural comparison on the
  //    closed-list fields), persist. Otherwise: drop this attempt —
  //    the next reconnect's passport-fetch re-attempts against the
  //    fresher snapshot.
  //
  //    `null === null` is treated as equal (no prior pin both times);
  //    a transition from null → seeded counts as moved iff a non-null
  //    snapshot landed in between.
  let snapshotAtWrite: WebclientCertPinState | null;
  try {
    snapshotAtWrite = await localStore.get('cert_pin_state');
  } catch (err) {
    // Treat a read failure as a write-blocking signal: persist would
    // race blind, so route through onError with stage=persist (the
    // closest semantic — the persist couldn't complete safely).
    const wrapped = err instanceof Error ? err : new Error(String(err));
    if (onError) {
      try {
        onError(wrapped, { stage: 'persist' });
      } catch {
        /* failure-report sink must never re-enter the orchestrator */
      }
    }
    return;
  }
  if (!isSameCertPinSnapshot(current, snapshotAtWrite)) {
    // A concurrent transition landed between our read + write — drop
    // this attempt + let the next reconnect's verify path re-evaluate
    // against the fresher snapshot. The drop is silent: not an error,
    // just a CAS retry signal. The cert-pin handler's own broadcast-
    // driven transition wins.
    return;
  }

  try {
    await localStore.set('cert_pin_state', result.next);
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    if (onError) {
      try {
        onError(wrapped, { stage: 'persist' });
      } catch {
        /* failure-report sink must never re-enter the orchestrator */
      }
    }
    return;
  }

  // 6. Notify the cert-pin state watcher (when wired). The Settings →
  //    Server cert-pin-stale panel subscribes to the watcher; this
  //    fires a synchronous rerender so the panel hides immediately
  //    on promote without waiting for the 60s polling tick.
  if (certPinWatcher) {
    try {
      certPinWatcher.notify(result.next);
    } catch {
      /* watcher notify is best-effort — its own subscribers isolate */
    }
  }
};

/** Structural comparison over the closed-list `WebclientCertPinState`
 *  fields. `null === null` returns true (no prior pin both times).
 *  Used by the CAS check above (Codex 2026-05-17 P2 fold, slice 116)
 *  to detect a concurrent transition between the verify path's read
 *  + write. The cert-pin handler is the only other writer of
 *  `cert_pin_state` — its transitions are bounded, so structural
 *  comparison over the 5 closed-list fields is sufficient (no need
 *  for content-addressed snapshot ids). */
const isSameCertPinSnapshot = (
  a: WebclientCertPinState | null,
  b: WebclientCertPinState | null,
): boolean => {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return (
    a.current_fingerprint === b.current_fingerprint &&
    a.next_fingerprint === b.next_fingerprint &&
    a.previous_fingerprint === b.previous_fingerprint &&
    a.previous_valid_until === b.previous_valid_until &&
    a.current_valid_until === b.current_valid_until &&
    a.last_rotated_at === b.last_rotated_at
  );
};
