/** D-148 § A.6.5 — `cert.rotation_notice` + `cert.rotation_reverted`
 *  broadcast handler.
 *
 *  Drives the two-pin overlap protocol from the webclient side:
 *
 *    1. Subscribes to the two cert-rotation broadcasts.
 *    2. Verifies the Ed25519 signature on each notice against the
 *       pinned `server_public_key` — invalid signatures are dropped
 *       silently (spec § A.6.5: "Forged notices fail signature
 *       verification + are ignored").
 *    3. Updates `WebclientLocalStore.cert_pin_state`:
 *       - On `cert.rotation_notice`: stages `next_fingerprint` +
 *         updates `current_valid_until` to `rotation_at` (the moment
 *         the current cert stops being authoritative); leaves
 *         `current_fingerprint` untouched.
 *       - On `cert.rotation_reverted`: restores
 *         `current_fingerprint = reverted_to_fingerprint`, clears
 *         `next_fingerprint`, refreshes `last_rotated_at`.
 *
 *  ── Key design decisions (READ before touching) ─────────────────────
 *
 *  DD#1 — Signature transcript byte-shape. The server's
 *  `verifyCertRotationNotice` signs the literal-order object via
 *  `JSON.stringify` — NOT `canonicalJSONStringify`. The four signed
 *  fields are `{ current_fingerprint, next_fingerprint, rotation_at,
 *  type }` for the notice and `{ reverted_to_fingerprint, reason:
 *  reason ?? null, reverted_at, type }` for the revert (reason is
 *  ALWAYS present, coerced to `null` when undefined). Neither
 *  `signer_fingerprint` nor `emitted_at` ride in the signed bytes.
 *  This handler reproduces that exact object literal order — sender
 *  + verifier MUST agree on bytes to the last comma.
 *
 *  DD#2 — Initial-pin acquisition is NOT the handler's job. Pair-time
 *  acquisition lands `current_fingerprint` via the bearer-issuance
 *  response from `POST /auth/pair` (D-156 P10 retired the inner pair-
 *  blob payload that previously carried the field); this handler is
 *  purely the post-pair rotation flow. If the local store
 *  has no `cert_pin_state` when a notice arrives (server emitted
 *  before pair carried cert info), the handler still persists
 *  `next_fingerprint` so a subsequent `cert.rotated` (or a passport
 *  fetch) can promote it; the missing `current_fingerprint` is left
 *  as the empty string (the contract reads it as `string`, not
 *  optional, so we have to pick something — empty string is the
 *  "no pin yet" sentinel that the future passport-fetch path treats
 *  as "accept whatever the server vouches for").
 *
 *  DD#3 — Failure isolation. Every code path that touches the store
 *  is wrapped so a single bad row doesn't kill the dispatch loop.
 *  Failures land in the optional `onError` sink keyed by stage:
 *  `verify` / `read_pair_context` / `persist`. The handler never
 *  throws into the subscriber.
 *
 *  DD#4 — Sibling event isolation. Unlike `token.rotated` (which has
 *  a `target_token_id` discriminator so siblings can no-op), the cert
 *  rotation notices are pair-scoped — every paired client receives
 *  them AND every paired client applies them. There's only one cert
 *  per server, so there's no target field. Every subscriber writes
 *  to its own local store independently. */

import {
  canonicalPassportSigningPayload,
  PASSPORT_FETCH_PREVIOUS_VALID_WINDOW_MS,
  type ServerEvent,
  type ServerPassportProjection,
  type WebclientCertPinState,
} from '@recued/contracts';

import { verifyEd25519 } from '../auth/ed25519-verifier.js';
import type { WebclientLocalStore } from '../storage/local-store.js';
import type { BroadcastSubscriber } from './subscriber.js';

/** Closed list of failure stages reported through `onError`. */
export type CertPinFailureStage =
  | 'verify'                       // signature failed Ed25519 verify
  | 'read_pair_context'            // local store read failed
  | 'current_fingerprint_mismatch' // signed notice for a different lineage
  | 'rotation_at_in_past'          // notice arrived after T (stale / replay)
  | 'pin_unknown_revert_target'    // revert names a fingerprint we don't trust
  | 'persist';                     // local store write failed

export interface CertPinFailureContext {
  stage: CertPinFailureStage;
  /** The kind that triggered the failure — surfaces in audit /
   *  telemetry so the rare invalid-signature signal is queryable. */
  kind: 'cert.rotation_notice' | 'cert.rotation_reverted';
}

export interface CreateCertPinHandlerOptions {
  localStore: WebclientLocalStore;
  subscriber: BroadcastSubscriber;
  /** Best-effort failure sink. Defaults to no-op. */
  onError?: (err: Error, context: CertPinFailureContext) => void;
  /** Clock seam (tests). Defaults to `Date.now`. Used by the
   *  `rotation_at_in_past` gate — notices whose handoff timestamp is
   *  already past are stale / replay attempts and never advance the
   *  pinned state. */
  now?: () => number;
  /** Best-effort callback fired AFTER a successful localStore persist
   *  with the newly-applied state. The Settings → Server cert-pin
   *  status panel (slice 113) subscribes via the cert-pin state
   *  watcher to surface the two-pin overlap during the 7d window
   *  without re-reading localStore (which would race the persist).
   *  Throws are swallowed so a broken subscriber cannot poison the
   *  dispatch chain. */
  onStateChanged?: (state: WebclientCertPinState) => void;
}

export interface CertPinHandler {
  dispose(): void;
  /** Await the internal serialization chain. Test affordance — drains
   *  all currently-enqueued work so assertions can read the resulting
   *  store state without polling. In production this is unused: the
   *  handler is fire-and-forget on each broadcast. */
  flush(): Promise<void>;
}

type CertRotationNoticeEvent = Extract<ServerEvent, { kind: 'cert.rotation_notice' }>;
type CertRotationRevertedEvent = Extract<
  ServerEvent,
  { kind: 'cert.rotation_reverted' }
>;

// ════════════════════════════════════════════════════════════════
// Signature transcripts
// ════════════════════════════════════════════════════════════════

/** Reconstruct the unsigned payload bytes for a rotation notice.
 *  Mirrors `backend/server/src/keys/rotation/cert-rotation-verifier.ts`
 *  `verifyCertRotationNotice` exactly: literal-order object, four
 *  fields, plain `JSON.stringify` (NOT canonical). Diverging produces
 *  a different byte sequence — Codex 2026-05-15 P1 fold. */
const buildRotationNoticeTranscript = (
  notice: CertRotationNoticeEvent,
): Uint8Array => {
  const signed = JSON.stringify({
    current_fingerprint: notice.current_fingerprint,
    next_fingerprint: notice.next_fingerprint,
    rotation_at: notice.rotation_at,
    type: 'cert_rotation_notice',
  });
  return new TextEncoder().encode(signed);
};

/** Reconstruct the unsigned payload bytes for a revert event.
 *  Mirrors `verifyCertRotationRevertedEvent` exactly: `reason` is
 *  coerced to `null` when absent so the signed bytes match for both
 *  variants (Codex 2026-05-15 P2 fold). */
const buildRotationRevertedTranscript = (
  reverted: CertRotationRevertedEvent,
): Uint8Array => {
  const signed = JSON.stringify({
    reverted_to_fingerprint: reverted.reverted_to_fingerprint,
    reason: reverted.reason ?? null,
    reverted_at: reverted.reverted_at,
    type: 'cert_rotation_reverted',
  });
  return new TextEncoder().encode(signed);
};

// ════════════════════════════════════════════════════════════════
// State derivations
// ════════════════════════════════════════════════════════════════

/** Closed list of rejection reasons from the pure transition
 *  helpers. Mirrors the server-side `CertRotationApplyResult` so
 *  client + server fail with parallel vocabulary. */
export type CertPinTransitionRejection =
  | 'current_fingerprint_mismatch'
  | 'rotation_at_in_past'
  | 'pin_unknown_revert_target';

export type CertPinTransitionResult<TKind extends 'notice' | 'reverted'> =
  | { ok: true; next: WebclientCertPinState }
  | { ok: false; reason: CertPinTransitionRejection; kind: TKind };

/** Apply a rotation notice to the current pin state. Pure — no IO;
 *  enforces the spec § A.6.5 + server-side `applyCertRotationNotice`
 *  transition rules:
 *
 *   - The notice's `current_fingerprint` MUST match the pinned
 *     `current_fingerprint` (otherwise it's a stale or wrong-lineage
 *     notice; Codex 2026-05-15 P2 fold).
 *   - `rotation_at` MUST be in the future relative to `now` (a notice
 *     arriving past the handoff is stale / replay).
 *   - If no prior pin exists (DD#2: pre-acquisition client), the
 *     notice's `current_fingerprint` seeds it — the current_mismatch
 *     gate is bypassed in that case since there's nothing to mismatch
 *     against. */
export const applyRotationNoticeToState = (
  current: WebclientCertPinState | null,
  notice: CertRotationNoticeEvent,
  now: number,
): CertPinTransitionResult<'notice'> => {
  if (notice.rotation_at <= now) {
    return { ok: false, reason: 'rotation_at_in_past', kind: 'notice' };
  }
  const havePrior =
    current?.current_fingerprint !== undefined &&
    current.current_fingerprint.length > 0;
  if (havePrior && current!.current_fingerprint !== notice.current_fingerprint) {
    return { ok: false, reason: 'current_fingerprint_mismatch', kind: 'notice' };
  }
  return {
    ok: true,
    next: {
      // When havePrior we keep the pinned current; when seeding,
      // we accept the notice's current as the new pin.
      current_fingerprint: havePrior
        ? current!.current_fingerprint
        : notice.current_fingerprint,
      next_fingerprint: notice.next_fingerprint,
      current_valid_until: notice.rotation_at,
      ...(current?.last_rotated_at !== undefined
        ? { last_rotated_at: current.last_rotated_at }
        : {}),
      // Preserve `previous_fingerprint` + `previous_valid_until`
      // across a notice (slice 115 follow-up + slice 116 window-guard):
      // the slot tracks the immediate prior current from the LAST
      // passport-fetch promotion. A notice stages the NEXT rotation
      // but doesn't complete it (no promotion yet), so the prior
      // rollback target is still valid until a subsequent promotion
      // overwrites it or a revert consumes it. The window guard
      // (`previous_valid_until > now`) gates revert acceptance — the
      // notice itself doesn't re-validate the window.
      ...(current?.previous_fingerprint !== undefined
        ? { previous_fingerprint: current.previous_fingerprint }
        : {}),
      ...(current?.previous_valid_until !== undefined
        ? { previous_valid_until: current.previous_valid_until }
        : {}),
    },
  };
};

/** Apply a revert event. Mirrors server-side `applyCertRotationReverted-
 *  Event`: the `reverted_to_fingerprint` MUST match the pinned current,
 *  the staged next (the latter covers the revert-mid-overlap case where
 *  the client has already flipped), OR the retained `previous_fingerprint`
 *  (the latter covers the post-promotion rollback case where the
 *  webclient already promoted via passport-fetch + the server then
 *  reverts; the prior current is the only trusted target left). Unknown
 *  targets reject — they could move the pin to a cert the client never
 *  trusted (Codex 2026-05-15 P2 fold).
 *
 *  Codex 2026-05-17 P2 fold (slice 115 follow-up) — `previous_fingerprint`
 *  match support. Pre-fold the revert handler accepted only matches on
 *  `current` or `next`. After the passport-fetch verify path promotes a
 *  staged-next (clearing `next` + replacing `current`), a `cert.rotation_
 *  reverted` event naming the OLD `current` would reject as
 *  `pin_unknown_revert_target`. Retaining `previous_fingerprint` on
 *  promotion (in `applyObservedCertFingerprintToState`) + widening the
 *  revert match here closes the rollback gap end-to-end. A successful
 *  revert clears `previous_*` since the rollback target has become the
 *  new pinned current.
 *
 *  Codex 2026-05-17 P2 fold (slice 116) — `previous_*` window guard.
 *  The widened revert match accepts `previous_fingerprint` only while
 *  `now < previous_valid_until`. Without this gate, a signed but stale
 *  `cert.rotation_reverted` (Ed25519-replayable; the server doesn't
 *  bind freshness into the rotation-notice transcript) could roll the
 *  pin back to a long-decommissioned cert. The window is set on
 *  promotion to 7d (matches the spec's cert-rotation overlap). When
 *  `now` is unavailable to the caller (e.g. legacy callers that don't
 *  thread a clock), pass `now = undefined` to skip the window check
 *  (BACK-COMPAT — the explicit-clock path is the recommended one for
 *  the verify-path orchestrator). */
export const applyRotationRevertedToState = (
  current: WebclientCertPinState | null,
  reverted: CertRotationRevertedEvent,
  now?: number,
): CertPinTransitionResult<'reverted'> => {
  const matchesCurrent =
    current?.current_fingerprint !== undefined &&
    current.current_fingerprint === reverted.reverted_to_fingerprint;
  const matchesNext =
    current?.next_fingerprint !== undefined &&
    current.next_fingerprint === reverted.reverted_to_fingerprint;
  const matchesPreviousFingerprint =
    current?.previous_fingerprint !== undefined &&
    current.previous_fingerprint === reverted.reverted_to_fingerprint;
  // Window guard — the previous slot is only honored while we're still
  // inside the overlap window from the last promotion. Skipped when
  // `now` is undefined (legacy caller path) or when the slot was set
  // without an explicit window (defense-in-depth — promotion always
  // sets both fields together; this fallback rejects rather than
  // accepts the stale slot).
  const previousWithinWindow =
    matchesPreviousFingerprint &&
    current?.previous_valid_until !== undefined &&
    (now === undefined || now < current.previous_valid_until);
  if (!matchesCurrent && !matchesNext && !previousWithinWindow) {
    return { ok: false, reason: 'pin_unknown_revert_target', kind: 'reverted' };
  }
  return {
    ok: true,
    next: {
      current_fingerprint: reverted.reverted_to_fingerprint,
      current_valid_until: current?.current_valid_until ?? reverted.reverted_at,
      last_rotated_at: reverted.reverted_at,
      // Drop next_fingerprint — the revert means the staged rotation
      // is abandoned.
      //
      // Drop previous_fingerprint + previous_valid_until — the rollback
      // target has become the new pinned current; there's no longer a
      // "prior" to keep around (a subsequent rotation that wants
      // rollback support will repopulate them on its own promotion
      // path).
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Passport-fetch verify path (D-148 § A.6.5 + § A.9, slice 115)
// ════════════════════════════════════════════════════════════════

/** D-148 § A.6.5 / § A.9 — passport-fetch verify path: outcome of the
 *  observed-fingerprint transition.
 *
 *  The slices 113 + 114 cert-pin-stale panel hides on `cert.rotation_
 *  reverted` (next_fingerprint cleared by revert) and on time-passage
 *  past `current_valid_until` (driven by the 60s polling tick). It does
 *  NOT hide on real promotion — the rotation-notice handler stages
 *  next_fingerprint but never promotes it, since the webclient cannot
 *  observe a TLS cert directly through the browser's `WebSocket` API.
 *  The "passport-fetch verify path" closes this gap: post-WS-connect
 *  the client fetches the server's signed passport (`passport.fetch`
 *  rpc — a future slice), reads the passport's
 *  `network.cert_fingerprint` claim, verifies the signature against
 *  the pinned `server_public_key`, and applies the transition below.
 *
 *  Three success outcomes:
 *
 *   - `seeded`     — no prior pin (DD#2 empty-string sentinel or null
 *                    state). Accept the observed cert as the new
 *                    baseline; clear any stray staged-next.
 *   - `promoted`   — observed matches `next_fingerprint`. Promote it
 *                    to `current_fingerprint`; clear next; stamp
 *                    `last_rotated_at = now`. The cert-pin-stale panel
 *                    hides at the next post-persist tick.
 *   - `idempotent` — observed matches the pinned `current_fingerprint`.
 *                    No state change; the caller can skip the persist.
 *                    Returns the input state by reference so the
 *                    watcher's reference-equality short-circuit
 *                    (DD#5 in the state watcher) skips the rerender.
 *
 *  One failure mode:
 *
 *   - `observed_fingerprint_unknown` — observed matches neither the
 *                    pinned current nor the staged next AND a prior
 *                    pin exists. This is the MITM-class signal: a
 *                    cert the client never authorized. Caller emits
 *                    `pair_required` so the user re-pairs through the
 *                    admin-token-gated flow (§ A.6.5 line 918). */
export type CertPinObservedTransitionRejection = 'observed_fingerprint_unknown';

export type CertPinObservedOutcome = 'seeded' | 'promoted' | 'idempotent';

export type CertPinObservedTransitionResult =
  | { ok: true; next: WebclientCertPinState; outcome: CertPinObservedOutcome }
  | { ok: false; reason: CertPinObservedTransitionRejection };

export interface ApplyObservedCertFingerprintArgs {
  observed_fingerprint: string;
  observed_valid_until: number;
}

/** Pure transition for the passport-fetch verify path. The caller
 *  (verifier wrapper below or a direct test) supplies an already-
 *  trusted fingerprint + cert expiry; this function decides whether to
 *  seed, promote, no-op, or reject.
 *
 *  Idempotent contract: when observed matches the pinned current the
 *  function returns the input state by reference (`next === current`)
 *  + outcome `'idempotent'` so the caller can short-circuit the
 *  persist. The state watcher's reference-equality guard (DD#5) means
 *  a same-reference `notify()` is a no-op even if the caller does
 *  persist — defense in depth.
 *
 *  Empty observed string is treated as a malformed input + rejects
 *  with `observed_fingerprint_unknown` (zero-length fingerprints
 *  cannot match the closed `WebclientCertPinState.current_fingerprint`
 *  sentinel without overloading the DD#2 semantics). */
export const applyObservedCertFingerprintToState = (
  current: WebclientCertPinState | null,
  args: ApplyObservedCertFingerprintArgs,
  now: number,
): CertPinObservedTransitionResult => {
  const { observed_fingerprint, observed_valid_until } = args;
  if (observed_fingerprint.length === 0) {
    return { ok: false, reason: 'observed_fingerprint_unknown' };
  }
  const havePrior =
    current?.current_fingerprint !== undefined &&
    current.current_fingerprint.length > 0;
  if (!havePrior) {
    // DD#2 seed: accept whatever the server vouches for. Any stray
    // staged-next from a prior rotation_notice (which would have
    // populated next without a current) is dropped — the observed
    // cert IS the new baseline.
    const next: WebclientCertPinState = {
      current_fingerprint: observed_fingerprint,
      current_valid_until: observed_valid_until,
    };
    if (current?.last_rotated_at !== undefined) {
      next.last_rotated_at = current.last_rotated_at;
    }
    return { ok: true, outcome: 'seeded', next };
  }
  if (current!.current_fingerprint === observed_fingerprint) {
    // Idempotent — return the input ref so the caller (+ watcher)
    // short-circuit on reference equality.
    return { ok: true, outcome: 'idempotent', next: current! };
  }
  if (
    current!.next_fingerprint !== undefined &&
    current!.next_fingerprint === observed_fingerprint
  ) {
    // Promotion — server flipped to the staged-next cert during the
    // overlap window. Drop next; retain the prior current as
    // `previous_fingerprint` so a subsequent `cert.rotation_reverted`
    // naming the OLD current still finds a trusted rollback target
    // (Codex 2026-05-17 P2 fold, slice 115 follow-up). Stamp
    // last_rotated_at + bound previous's acceptance window via
    // `previous_valid_until` (7d, matches the spec's cert-rotation
    // overlap; Codex 2026-05-17 P2 fold, slices 116a + 116b — defends
    // against signed-but-stale `cert.rotation_reverted` replay
    // rolling back the pin long after the OLD cert has been
    // decommissioned).
    //
    // Codex 2026-05-17 P2 fold (slice 116b) — base the window on the
    // ROTATION TIME (`current.current_valid_until`, which the staging
    // notice set to `rotation_at`), NOT on `now`. A client that was
    // offline for part of the overlap would otherwise extend trust
    // far past the spec's bound: promoting at T+6d after a notice
    // for T with `now`-based stamping yields trust until T+13d, but
    // the OLD cert was already decommissioned at T+7d (the spec's
    // overlap end). Rotation-time stamping yields trust until T+7d
    // regardless of when the client observed the new cert.
    //
    // Lifetime contract: `previous_fingerprint` + `previous_valid_until`
    // are retained ONLY by promotion. A real revert consumes the
    // slot (clears both since the rollback target has become the new
    // pinned current); the next routine `cert.rotation_notice` will
    // overwrite them on its own promotion path. The cert-pin-stale
    // panel ignores them for render purposes — the panel renders on
    // `next_fingerprint` presence, not on `previous_fingerprint`.
    return {
      ok: true,
      outcome: 'promoted',
      next: {
        current_fingerprint: observed_fingerprint,
        previous_fingerprint: current!.current_fingerprint,
        // `current.current_valid_until` was set to `rotation_at` by
        // the staging notice (`applyRotationNoticeToState`) — base
        // the window on that to keep the rollback bound aligned with
        // the spec's overlap window regardless of when this client
        // observed the new cert.
        previous_valid_until:
          current!.current_valid_until + PASSPORT_FETCH_PREVIOUS_VALID_WINDOW_MS,
        current_valid_until: observed_valid_until,
        last_rotated_at: now,
      },
    };
  }
  // Observed cert matches neither current nor next — re-pair signal.
  return { ok: false, reason: 'observed_fingerprint_unknown' };
};

/** Verify-stage rejection reasons specific to the passport-fetch path.
 *  Composed with `CertPinObservedTransitionRejection` so the caller
 *  funnels both stages through one `reason` discriminator. */
export type PassportCertVerifyRejection =
  | 'signature_invalid'         // Ed25519 verify failed against pinned server_public_key
  | 'identity_key_mismatch'     // passport.identity.server_public_key differs from pinned key
  | 'cert_fingerprint_missing'  // passport.network.cert_fingerprint absent / empty
  | 'passport_stale'            // exported_at outside the freshness window (Codex P2 fold, slice 115)
  | CertPinObservedTransitionRejection;

export type PassportCertVerifyResult =
  | { ok: true; next: WebclientCertPinState; outcome: CertPinObservedOutcome }
  | { ok: false; reason: PassportCertVerifyRejection };

/** Maximum age the passport's `exported_at` may have relative to the
 *  caller's clock before the verify gate rejects it. Default 5 min
 *  matches the engine-wide bearer / pair-blob freshness budget — long
 *  enough to tolerate moderate clock skew, short enough that a stale
 *  signed passport (e.g., an attacker replaying a `passport.export`
 *  payload that the user previously shared) doesn't get treated as
 *  an authoritative observed-cert claim. The post-WS-connect
 *  `passport.fetch` rpc (future slice) mints a fresh passport on
 *  demand, so the freshness window only ever rejects pathological
 *  inputs. Override with the options arg for tests / clock-skewed
 *  hosts. */
export const DEFAULT_PASSPORT_VERIFY_MAX_AGE_MS = 5 * 60_000;

/** Maximum future-skew the passport's `exported_at` may have. A
 *  passport claiming to be minted in the future is either a clock-skew
 *  artifact (rare — server clocks are NTP-disciplined) or a forgery
 *  attempt; the 60-second tolerance covers benign skew without giving
 *  an attacker a sliding-window replay budget. */
export const DEFAULT_PASSPORT_VERIFY_FUTURE_SKEW_MS = 60_000;

export interface VerifyPassportCertAttestationOptions {
  /** Override the default 5-minute max age (see
   *  `DEFAULT_PASSPORT_VERIFY_MAX_AGE_MS`). Tests use a wider window
   *  to stabilize against the FIXED_NOW seam; production keeps the
   *  default. */
  maxAgeMs?: number;
  /** Override the default 60s future-skew tolerance. */
  futureSkewMs?: number;
}

/** D-148 § A.6.5 + § A.9 — passport-fetch verify path. Given a signed
 *  passport projection (any of the three profiles — all carry the
 *  fields below) + the pinned `server_public_key` + the current pin
 *  state + clock, this function:
 *
 *    1. Verifies the Ed25519 signature against the pinned
 *       `server_public_key` over the canonical-JSON-stripped payload
 *       (matches the server-side `signServerPassport` transcript so
 *       sender + verifier agree on bytes to the last comma).
 *    2. Verifies `passport.exported_at` falls within the freshness
 *       window `[now - maxAgeMs, now + futureSkewMs]` (Codex P2 fold,
 *       slice 115). The Ed25519 signature is replayable on its own —
 *       a passport signed yesterday with `cert_fingerprint: oldX`
 *       would otherwise be accepted today as a valid attestation
 *       even after rotation moved the live cert to `newY`. Binding
 *       to `exported_at` makes the attestation a same-session claim,
 *       not a historical one.
 *    3. Verifies the passport's `identity.server_public_key` matches
 *       the pinned key (spec § A.9 line 1290: defense against passport
 *       replay after a `server_identity_key` rotation — a passport
 *       minted by the OLD key would still verify against the pinned
 *       key but its identity block would point at the OLD public key;
 *       the mismatch flags the replay).
 *    4. Asserts `network.cert_fingerprint` is present + non-empty.
 *    5. Delegates the seed / promote / no-op / reject decision to
 *       `applyObservedCertFingerprintToState`.
 *
 *  Returns a unified result. The caller persists on `outcome !==
 *  'idempotent'`, emits `pair_required` on
 *  `reason === 'observed_fingerprint_unknown'`, and funnels the
 *  verify-stage rejections through the same telemetry sink as the
 *  rotation-notice handler.
 *
 *  ── Threat-model scope (Codex 2026-05-17 P1, slice 115) ─────────────
 *
 *  This primitive is REPLAY + IDENTITY-ROTATION defense, not a
 *  complete cert-pinning defense from a browser. The browser's
 *  `WebSocket` API does not expose the TLS cert fingerprint of the
 *  accepted connection to JavaScript, so the verify path cannot
 *  compare the passport's claimed `cert_fingerprint` against what
 *  the browser actually observed at handshake. A CA-compromise MITM
 *  with a forged-but-CA-validated cert can present its own cert to
 *  the browser, proxy the `passport.fetch` rpc to the real server,
 *  and return a signed passport whose `cert_fingerprint` matches
 *  the pinned current — this gate then returns `idempotent` and the
 *  webclient continues to trust the MITM channel. The real defenses
 *  for that attacker class live elsewhere:
 *
 *   - **Browser TLS trust store + Certificate Transparency** — spec
 *     § A.6.5 lines 12-20 (CT log monitoring + CAA records pinning
 *     Let's Encrypt + emergency handle freeze).
 *   - **Bridge-context cert pinning** — a future Bridge slice can use
 *     the Manifest V3 `webRequest` API to observe the TLS cert
 *     fingerprint directly; the verify-path primitive can then
 *     compose against that observation, not against the passport's
 *     claim. Outside the webclient runtime; out of scope here.
 *   - **Signed rotation events** — `cert.rotation_notice` /
 *     `cert.rotation_reverted` Ed25519-verified against the pinned
 *     `server_public_key` are immune to MITM (the attacker lacks
 *     the server_identity_key). The webclient's PRIMARY rotation
 *     defense is those signed events; passport-fetch closes the
 *     "client missed the bus replay window" gap by letting an offline
 *     client catching up promote based on a signed passport's claim. */
export const verifyPassportCertAttestation = async (
  passport: ServerPassportProjection,
  pinnedServerPublicKey: string,
  current: WebclientCertPinState | null,
  now: number,
  options?: VerifyPassportCertAttestationOptions,
): Promise<PassportCertVerifyResult> => {
  // Strip the signature, canonical-JSON the rest, encode as UTF-8.
  // Mirrors the server's `signServerPassport` transcript exactly.
  const transcript = new TextEncoder().encode(
    canonicalPassportSigningPayload(passport),
  );
  const sigOk = await verifyEd25519(
    pinnedServerPublicKey,
    transcript,
    passport.signature,
  );
  if (!sigOk) {
    return { ok: false, reason: 'signature_invalid' };
  }
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_PASSPORT_VERIFY_MAX_AGE_MS;
  const futureSkewMs =
    options?.futureSkewMs ?? DEFAULT_PASSPORT_VERIFY_FUTURE_SKEW_MS;
  if (
    passport.exported_at > now + futureSkewMs ||
    passport.exported_at < now - maxAgeMs
  ) {
    return { ok: false, reason: 'passport_stale' };
  }
  if (passport.identity.server_public_key !== pinnedServerPublicKey) {
    return { ok: false, reason: 'identity_key_mismatch' };
  }
  if (passport.network.cert_fingerprint.length === 0) {
    return { ok: false, reason: 'cert_fingerprint_missing' };
  }
  return applyObservedCertFingerprintToState(
    current,
    {
      observed_fingerprint: passport.network.cert_fingerprint,
      observed_valid_until: passport.network.cert_expires_at,
    },
    now,
  );
};

// ════════════════════════════════════════════════════════════════
// Handler
// ════════════════════════════════════════════════════════════════

export const createCertPinHandler = (
  options: CreateCertPinHandlerOptions,
): CertPinHandler => {
  const { localStore, subscriber, onError, onStateChanged } = options;
  const clock = options.now ?? Date.now;
  const report = (err: Error, context: CertPinFailureContext): void => {
    if (!onError) return;
    try {
      onError(err, context);
    } catch {
      /* failure-report sink must never re-enter the handler */
    }
  };

  // The two handlers are serialized through a single promise chain
  // so a fast burst of notice + revert events can't read-modify-
  // write the local store concurrently (mirrors the token-rotation
  // P2 fold). Each task awaits the prior.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): void => {
    chain = chain.then(task).catch(() => undefined);
  };

  const handleNotice = async (notice: CertRotationNoticeEvent): Promise<void> => {
    // 1. Read pinned server_public_key.
    let serverPublicKey: string | null;
    try {
      serverPublicKey = await localStore.get('server_public_key');
    } catch (err) {
      report(err as Error, { stage: 'read_pair_context', kind: notice.kind });
      return;
    }
    if (!serverPublicKey) {
      report(
        new Error('cert-pin handler: server_public_key missing; cannot verify notice'),
        { stage: 'read_pair_context', kind: notice.kind },
      );
      return;
    }
    // 2. Verify signature against the canonical transcript.
    const transcript = buildRotationNoticeTranscript(notice);
    const sigOk = await verifyEd25519(serverPublicKey, transcript, notice.signature);
    if (!sigOk) {
      report(
        new Error('cert-pin handler: rotation_notice signature did not verify'),
        { stage: 'verify', kind: notice.kind },
      );
      return;
    }
    // 3. Apply + persist (with transition gates).
    let currentState: WebclientCertPinState | null;
    try {
      currentState = await localStore.get('cert_pin_state');
    } catch (err) {
      report(err as Error, { stage: 'read_pair_context', kind: notice.kind });
      return;
    }
    const transition = applyRotationNoticeToState(currentState, notice, clock());
    if (!transition.ok) {
      report(
        new Error(`cert-pin handler: rotation_notice rejected (${transition.reason})`),
        { stage: transition.reason, kind: notice.kind },
      );
      return;
    }
    try {
      await localStore.set('cert_pin_state', transition.next);
    } catch (err) {
      report(err as Error, { stage: 'persist', kind: notice.kind });
      return;
    }
    if (onStateChanged) {
      try {
        onStateChanged(transition.next);
      } catch {
        /* state-changed sink must never re-enter the handler */
      }
    }
  };

  const handleRevert = async (
    reverted: CertRotationRevertedEvent,
  ): Promise<void> => {
    let serverPublicKey: string | null;
    try {
      serverPublicKey = await localStore.get('server_public_key');
    } catch (err) {
      report(err as Error, { stage: 'read_pair_context', kind: reverted.kind });
      return;
    }
    if (!serverPublicKey) {
      report(
        new Error('cert-pin handler: server_public_key missing; cannot verify revert'),
        { stage: 'read_pair_context', kind: reverted.kind },
      );
      return;
    }
    const transcript = buildRotationRevertedTranscript(reverted);
    const sigOk = await verifyEd25519(serverPublicKey, transcript, reverted.signature);
    if (!sigOk) {
      report(
        new Error('cert-pin handler: rotation_reverted signature did not verify'),
        { stage: 'verify', kind: reverted.kind },
      );
      return;
    }
    let currentState: WebclientCertPinState | null;
    try {
      currentState = await localStore.get('cert_pin_state');
    } catch (err) {
      report(err as Error, { stage: 'read_pair_context', kind: reverted.kind });
      return;
    }
    const transition = applyRotationRevertedToState(
      currentState,
      reverted,
      clock(),
    );
    if (!transition.ok) {
      report(
        new Error(`cert-pin handler: rotation_reverted rejected (${transition.reason})`),
        { stage: transition.reason, kind: reverted.kind },
      );
      return;
    }
    try {
      await localStore.set('cert_pin_state', transition.next);
    } catch (err) {
      report(err as Error, { stage: 'persist', kind: reverted.kind });
      return;
    }
    if (onStateChanged) {
      try {
        onStateChanged(transition.next);
      } catch {
        /* state-changed sink must never re-enter the handler */
      }
    }
  };

  const detachNotice = subscriber.on('cert.rotation_notice', (notice) => {
    enqueue(() => handleNotice(notice));
  });
  const detachRevert = subscriber.on('cert.rotation_reverted', (reverted) => {
    enqueue(() => handleRevert(reverted));
  });

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      detachNotice();
      detachRevert();
    },
    flush: async () => {
      // Snapshot the current chain; awaiting it twice catches a
      // chained-during-await enqueue (the second await reads the
      // chain ref AFTER the first task fired any synchronously-
      // enqueued follow-ups).
      await chain;
      await chain;
    },
  };
};
