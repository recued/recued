/** D-156 P5 — pair-code-input success-path persistence.
 *
 *  Drives the post-`/auth/pair` flow that closes the gap between the
 *  realm bearer the P3 host received + the 5 closed-list IDB fields
 *  the bootstrap reads. Replaces the placeholder "Reload to continue"
 *  splash with a real handoff.
 *
 *  Pipeline:
 *    1. `passport.fetch` over a one-shot authenticated WS (the
 *       [[pair-passport-invoker]] one-shot) — reads
 *       `identity.server_public_key`, `network.cert_fingerprint`,
 *       `network.cert_expires_at`, `identity.current_handle`.
 *    2. Mint a stable `token_id` for the AAD binding. The
 *       `/auth/pair` response does not include one (the realm bearer
 *       is opaque to the server's `client_tokens` table); we derive a
 *       UUIDv4 + use it BOTH as the AAD's `token_id` AND as
 *       `WebclientTokenRecord.token_id` so the unwrap-time AAD
 *       reconstruction lines up. The id is local-only — it never
 *       leaves the webclient.
 *    3. Wrap the realm bearer through `tokenStore.wrap` with the
 *       AAD triple (token_id + server_url + server_public_key).
 *    4. Derive `WebclientCertPinState` from the passport's cert
 *       fields when both are present (a server without a TLS cert
 *       yet — LAN-only setups — returns no `cert_fingerprint`; we
 *       write null in that case so any stale pin from a prior server
 *       is cleared).
 *    5. Build `WebclientPairMetadata` (paired_at + the passport's
 *       server_public_key as fingerprint + the current_handle).
 *    6. Select the server profile explicitly, then persist its other
 *       4 fields per-key. The local-store backend has no transaction
 *       primitive; the bootstrap's
 *       `hydratePairState` rejects half-paired states so a mid-write
 *       failure leaves the user in the unpaired form for a clean
 *       retry.
 *
 *  ── Key design decisions (READ before touching) ───────────────────
 *
 *  DD#1 — One-shot WS for passport.fetch, NOT the long-lived
 *  ws-client transport. Rationale: the bootstrap's ws-client takes
 *  AAD-wrapped storage as input; we don't have the wrap yet because
 *  we don't have server_public_key. The one-shot opens a transport
 *  with the bearer alone (carried in `Sec-WebSocket-Protocol` per server
 *  `extractRealm` — it used to be the `?token=` query fallback), calls one rpc,
 *  closes. Same shape as
 *  pair-consume-invoker's one-shot during the D-148 § A.2.1 era.
 *
 *  DD#2 — token_id is client-minted, not server-issued. The realm
 *  bearer is an opaque UUID-suffixed string the server stamps once
 *  per-pair; there is no separate `token_id` projection from
 *  `/auth/pair`. We mint a UUIDv4 client-side + use it as the AAD's
 *  token_id field. The id is purely local (drives the AES-GCM AAD
 *  binding + shows up in Settings → Privacy inspector) — the server
 *  never reads it. A future server change that returns a stable
 *  token id from `/auth/pair` can replace this mint without changing
 *  the contract.
 *
 *  DD#3 — On failure, the 5-field write is NOT attempted. A passport-
 *  fetch failure means we can't bind the AAD safely; surfacing as
 *  `pair_code_success_passport_failed` lets the host re-render the
 *  pair form with an error copy. The user re-submits with the same
 *  recovery key (still valid; the recovery sentinel was already
 *  seeded on the first `/auth/pair`) + a new pairing code (only if
 *  the realm needs first-pair enrollment, which it now does NOT
 *  since the sentinel is sealed). The recovery-key-only re-pair path
 *  is the recovery affordance documented in the design draft's
 *  Major #1 deferral.
 *
 *  DD#4 — `cert_pin_state` is null when EITHER cert field is
 *  missing. Matches `pair-input.ts` semantics for LAN-only servers.
 *  The bootstrap's passport-fetch verify path will seed the pin on
 *  the next reconnect once a cert lands.
 *
 *  DD#5 — `server_handle_at_pair` comes from the passport's
 *  `identity.current_handle`. The pair-blob flow used to plumb the
 *  empty string (the consume response carried no handle); we have
 *  it from the projection so we plumb it through. The Settings →
 *  Server "you paired to alice's server" copy renders this. */

import type {
  WebclientCertPinState,
  WebclientPairMetadata,
  WebclientTokenRecord,
} from '@recued/contracts';

import type { PairPassportInvoker } from './pair-passport-invoker.js';
import type {
  WebclientLocalStore,
  WebclientProfileStore,
} from '../storage/local-store.js';
import type {
  WebclientTokenAad,
  WebclientTokenStore,
} from '../storage/token-store.js';

// ════════════════════════════════════════════════════════════════
// Result taxonomy
// ════════════════════════════════════════════════════════════════

/** Closed-list error codes the host renders user-facing copy for.
 *  Mirrors the `PairCodeInputClientErrorCode` table from the input
 *  host so an integrated host can map both surfaces uniformly. */
export type PairCodeSuccessErrorCode =
  | 'pair_code_success_passport_failed'
  | 'pair_code_success_persist_failed'
  | 'pair_code_success_server_response_invalid'
  | 'pair_code_success_invalid_server_url'
  | 'pair_code_success_already_paired';

export const PAIR_CODE_SUCCESS_ERROR_COPY: Readonly<
  Record<PairCodeSuccessErrorCode, string>
> = {
  pair_code_success_passport_failed:
    "Pairing succeeded, but Recued couldn't finalize the handoff with your server. Reload and try again.",
  pair_code_success_persist_failed:
    "Pairing succeeded, but Recued couldn't save the credentials to local storage. Reload and try again.",
  pair_code_success_server_response_invalid:
    "Pairing succeeded, but your server's passport was unreadable. Reload and try again.",
  pair_code_success_invalid_server_url:
    "Your server URL is malformed — Recued couldn't open the WebSocket handoff. Re-enter the URL the server CLI printed and try again.",
  pair_code_success_already_paired:
    'Another tab finished pairing while this form was open. Reload the page to use the existing pair, or clear this browser from Settings to pair a new server.',
};

// ════════════════════════════════════════════════════════════════
// Cross-tab single-flight (Codex 2026-05-28 different-server fold)
// ════════════════════════════════════════════════════════════════

/** Stable lock name webclient instances serialise on. Same string
 *  across every browser tab on the origin — the Web Locks API treats
 *  same-name as exclusive serialisation by default. Externalised so
 *  tests can match against it and the bridge's analogous slice can
 *  reference it from documentation (the bridge runs its own SW-scoped
 *  single-flight via [[apps/bridge/src/boot/service-worker-bootstrap]]
 *  HIGH #11 fold; it never participates in this lock). */
export const PAIR_CODE_SUCCESS_LOCK_NAME =
  'recued.webclient.pair-finalize' as const;

/** Minimal projection of `navigator.locks` the finalize path actually
 *  uses. Letting consumers pass a fake at test time without monkey-
 *  patching `globalThis.navigator`. Production reads
 *  `globalThis.navigator.locks` and adapts it via this shape (the
 *  builtin's signature is structurally compatible). */
export interface PairFinalizeLockProvider {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T>;
}

/** Resolve the platform's Web Locks API or null when unavailable.
 *  Modern browsers (Chrome 69+ / Firefox 96+ / Safari 15.4+ / Edge 79+)
 *  expose `navigator.locks`; older browsers degrade to the entrance-
 *  guard-only behavior (the cross-tab same-server race is still
 *  closed; the rarer cross-tab different-server race remains). */
const resolveDefaultLockProvider = (): PairFinalizeLockProvider | null => {
  const navLike = (
    globalThis as { navigator?: { locks?: PairFinalizeLockProvider } }
  ).navigator;
  if (!navLike?.locks || typeof navLike.locks.request !== 'function') {
    return null;
  }
  return navLike.locks;
};

/** Serialise `fn` under the cross-tab pair-finalize lock when a
 *  provider is available; no-op fall-through when not. The provider's
 *  `request()` returns whatever `fn()` returns. Exported so the
 *  pair-code-input host can hoist the lock OUT to wrap `/auth/pair`
 *  itself (Codex 2026-05-28 trust-boundary fold — the realm bearer is
 *  issued by the server's `/auth/pair` POST; if two tabs race the POST
 *  + only the first to finalize wins, the loser has burned through a
 *  one-shot pair code or first-pair sentinel without persisting
 *  anything. Lifting the lock to wrap the POST itself prevents that
 *  silent code consumption). */
export const withPairFinalizeLock = async <T>(
  provider: PairFinalizeLockProvider | null,
  fn: () => Promise<T>,
): Promise<T> => {
  if (!provider) return fn();
  return provider.request(PAIR_CODE_SUCCESS_LOCK_NAME, { mode: 'exclusive' }, fn);
};

/** Default-resolver convenience for callers that want the lock without
 *  importing the lower-level helper. Same shape as
 *  `resolveDefaultLockProvider` (which is intentionally module-private —
 *  consumers should reach for this convenience rather than
 *  reimplementing the global lookup). */
export const resolveBrowserPairFinalizeLockProvider = (): PairFinalizeLockProvider | null =>
  resolveDefaultLockProvider();

// ════════════════════════════════════════════════════════════════
// Server-URL normalisation (Codex 2026-05-18 P5 R1 fold)
// ════════════════════════════════════════════════════════════════

/** Convert the user-typed HTTP server URL (the shape the CLI prints
 *  + the user types into the form) into the canonical WS endpoint
 *  the webclient's WS transport expects.
 *
 *  Codex 2026-05-18 P5 R1 critical fold — pre-fold the persisted
 *  `server_url` carried the raw user-typed value
 *  (`http://localhost:3001`). The WS transport's URL builder
 *  (`buildDefaultConnectUrl`) only appends `?token=...` without
 *  protocol or path conversion, so `new WebSocket('http://localhost:
 *  3001?token=...')` raised `SyntaxError` BEFORE the passport-fetch
 *  envelope ever shipped — `finalizePairCodeSuccess` always returned
 *  `pair_code_success_passport_failed` for the documented CLI URL
 *  shape. The D-148 § A.2.1 pair-blob flow side-stepped this by
 *  reading WS URLs verbatim from the inner payload's
 *  `server_address_hints`; the new pair-code flow lacks that
 *  channel, so we own the normalisation client-side.
 *
 *  Rules:
 *    - `http://`  → `ws://`
 *    - `https://` → `wss://`
 *    - Already-`ws(s)://` URLs pass through.
 *    - Trailing `/` is stripped before path inspection.
 *    - Path ending with `/ws` is preserved; otherwise `/ws` is
 *      appended (the server's `upgradeHandler` only accepts `/ws`
 *      per `backend/server/src/ws-server.ts:1152-1156`).
 *
 *  Returns null when the URL is structurally invalid (no
 *  protocol, empty host) so the orchestrator can surface a
 *  targeted error code instead of persisting a stub. */
export const normaliseServerUrlToWs = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  let withProtocol: string;
  if (lower.startsWith('https://')) {
    withProtocol = `wss://${trimmed.slice('https://'.length)}`;
  } else if (lower.startsWith('http://')) {
    withProtocol = `ws://${trimmed.slice('http://'.length)}`;
  } else if (lower.startsWith('wss://') || lower.startsWith('ws://')) {
    withProtocol = trimmed;
  } else {
    return null;
  }
  // Split into protocol prefix + remainder so the trailing-slash strip
  // never reaches into the `://` separator. Pre-fix the input was
  // routinely landing as `ws://` → trailing-slash strip → `ws:/` →
  // bogus `ws://ws` output (Codex 2026-05-18 P5 R1 test catch).
  const protoEnd = withProtocol.indexOf('://') + 3;
  const remainder = withProtocol.slice(protoEnd);
  if (remainder.length === 0) return null;
  // Now safe to strip a single trailing `/` from the remainder.
  const trimmedRemainder = remainder.endsWith('/')
    ? remainder.slice(0, -1)
    : remainder;
  if (trimmedRemainder.length === 0) return null;
  // Host portion is everything before the first `/` (if any).
  const pathIdx = trimmedRemainder.indexOf('/');
  if (pathIdx === 0) return null; // `ws:///ws` — empty host
  const protocol = withProtocol.slice(0, protoEnd);
  if (pathIdx < 0) {
    // No path — bare host. Append `/ws`.
    return `${protocol}${trimmedRemainder}/ws`;
  }
  const path = trimmedRemainder.slice(pathIdx);
  if (path === '/ws' || path.endsWith('/ws')) {
    return `${protocol}${trimmedRemainder}`;
  }
  return `${protocol}${trimmedRemainder}/ws`;
};

export type PairCodeSuccessResult =
  | {
      ok: true;
      server_url: string;
      server_public_key: string;
      token_id: string;
      pair_metadata: WebclientPairMetadata;
    }
  | { ok: false; error: PairCodeSuccessErrorCode; detail?: string };

// ════════════════════════════════════════════════════════════════
// Options
// ════════════════════════════════════════════════════════════════

export interface PairCodeSuccessOptions {
  /** Server URL the user typed into the form. Forwarded to the
   *  passport-fetch invoker; persisted verbatim (no normalisation —
   *  the user's value wins so the bootstrap reconnects against the
   *  same URL). */
  serverUrl: string;
  /** Realm bearer from `/auth/pair`. */
  bearer: string;
  /** Durable server-issued token id from `/auth/pair`. When absent,
   *  the legacy fallback mints a local id and uses raw bearer auth. */
  token_id?: string;
  /** Passport projection returned directly by `/auth/pair`. When
   *  absent, finalize falls back to one-shot `passport.fetch`. */
  passport?: unknown;
  /** Local store the active profile's 4 mutable fields write into. */
  localStore: WebclientLocalStore;
  /** Roster selector for profile-aware hosts. Production pairing supplies
   *  this explicitly so choosing the paired server does not depend on the
   *  five-key store's legacy `set('server_url')` compatibility interception.
   *  Optional only for older embedders and narrow hand-rolled tests. */
  profileStore?: Pick<WebclientProfileStore, 'ensureProfile'>;
  /** Token store that wraps the bearer with the non-extractable
   *  AES-GCM key. */
  tokenStore: WebclientTokenStore;
  /** One-shot passport.fetch invoker (production wires
   *  `createWebclientPairPassportInvoker`; tests inject a fake). */
  invokePassportFetch: PairPassportInvoker;
  /** D-151 follow-on — the locally-generated paired instance id the
   *  caller sent to `POST /auth/pair` as `instanceId`. Persisted into
   *  `pair_metadata.instance_id` so the Devices "This device" marker +
   *  any re-pair can reuse it. Optional: when absent, `pair_metadata`
   *  omits the field (the server still derives connect-time identity
   *  from the token metadata it already stamped). */
  instanceId?: string;
  /** Optional clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Optional id-mint seam (tests). Defaults to `randomUUID`. */
  mintTokenId?: () => string;
  /** Optional cross-tab single-flight provider (tests + browsers
   *  without `navigator.locks`). Production resolves
   *  `globalThis.navigator.locks` automatically; tests inject a fake
   *  that records request shape + simulates contention. Pass `null`
   *  explicitly to opt out (e.g. environments where the locks API is
   *  present but blocking would mask a test concern). */
  lockProvider?: PairFinalizeLockProvider | null;
}

// ════════════════════════════════════════════════════════════════
// Pipeline
// ════════════════════════════════════════════════════════════════

const defaultMintTokenId = (): string => {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  return `webclient-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
};

/** Derive `WebclientCertPinState` from the passport projection.
 *  Mirrors `deriveCertPinStateFromConsumeResponse` semantics from
 *  `pair-consume-bootstrap.ts` — returns null when EITHER field is
 *  missing so a LAN-only server (no cert yet) doesn't carry a stale
 *  pin from a prior pair. */
const deriveCertPinFromPassport = (
  cert_fingerprint: string | undefined,
  cert_expires_at: number | undefined,
): WebclientCertPinState | null => {
  if (typeof cert_fingerprint !== 'string' || cert_fingerprint.length === 0) {
    return null;
  }
  if (typeof cert_expires_at !== 'number' || !Number.isFinite(cert_expires_at)) {
    return null;
  }
  return {
    current_fingerprint: cert_fingerprint,
    current_valid_until: cert_expires_at,
  };
};

interface ExtractedPassportFields {
  server_public_key: string;
  cert_fingerprint: string | undefined;
  cert_expires_at: number | undefined;
  current_handle: string;
}

/** Pluck the fields the success path needs from the passport
 *  projection. Returns null when the projection is structurally
 *  invalid (missing identity block, non-string public key, etc.) so
 *  the orchestrator surfaces `pair_code_success_server_response_invalid`
 *  rather than persisting a half-baked pair state. */
const extractPassportFields = (
  passport: unknown,
): ExtractedPassportFields | null => {
  if (!passport || typeof passport !== 'object') return null;
  const p = passport as {
    identity?: { server_public_key?: unknown; current_handle?: unknown };
    network?: { cert_fingerprint?: unknown; cert_expires_at?: unknown };
  };
  const server_public_key = p.identity?.server_public_key;
  if (typeof server_public_key !== 'string' || server_public_key.length === 0) {
    return null;
  }
  const current_handle =
    typeof p.identity?.current_handle === 'string' ? p.identity.current_handle : '';
  const cf = p.network?.cert_fingerprint;
  const ce = p.network?.cert_expires_at;
  const out: ExtractedPassportFields = {
    server_public_key,
    cert_fingerprint:
      typeof cf === 'string' && cf.length > 0 ? cf : undefined,
    cert_expires_at:
      typeof ce === 'number' && Number.isFinite(ce) ? ce : undefined,
    current_handle,
  };
  return out;
};

/** Drive passport-fetch → wrap → write-5. Never throws — every
 *  failure surfaces as a tagged result so the host renders error
 *  copy in the same surface the form lives in.
 *
 *  Codex 2026-05-18 P5 R1 critical fold — the persisted `server_url`
 *  must be the canonical WS endpoint, NOT the raw HTTP URL the user
 *  typed into the form. The browser WebSocket constructor rejects
 *  `http(s)://` URLs at runtime AND the server only accepts upgrades
 *  on the `/ws` path, so we normalise BEFORE the passport-fetch
 *  call + persist the normalised form. A malformed URL surfaces as
 *  `pair_code_success_invalid_server_url` without touching the
 *  network or IDB. */
export const finalizePairCodeSuccess = async (
  options: PairCodeSuccessOptions,
): Promise<PairCodeSuccessResult> => {
  // Codex 2026-05-28 cross-tab single-flight fold — Web Locks serialise
  // concurrent webclient pair-finalize attempts across tabs on the same
  // origin.
  //
  // Two layers of lock:
  //   1. PRIMARY (defense at trust boundary) — the pair-code-input host
  //      acquires the SAME `recued.webclient.pair-finalize` lock around
  //      its `submit + onPaired` sequence, covering both `/auth/pair`
  //      AND the persistence below. See [[pair-code-input-host]]
  //      `doSubmit`. The host receives a `preflightCheck` callback
  //      that reads `webclient_token` so a winning tab's persistence
  //      makes the loser's pre-flight read see the populated token
  //      BEFORE consuming a one-shot pairing code or recovery-key
  //      first-pair sentinel on a different server.
  //   2. DEFENSE-IN-DEPTH (defense at persistence boundary) — the lock
  //      below runs only when `lockProvider !== null` is explicitly
  //      passed (production wires `lockProvider: null` from the host
  //      because re-entrant acquires same-name same-mode would
  //      deadlock the Web Locks queue). Tests + future programmatic
  //      callers that bypass the host pick up the persistence-level
  //      lock automatically via the default-resolver.
  //
  // Browsers without `navigator.locks` (extreme legacy) degrade to the
  // entrance-guard-only behavior at BOTH layers — the same-server race
  // is still closed by the guard's read-then-check pattern when the
  // OS's task scheduler doesn't preempt mid-sequence; the different-
  // server race becomes possible but the consequence (unwrap-failure
  // → clear-browser flow OR consumed-but-unused pair code on the
  // losing server) is non-destructive.
  const lockProvider =
    options.lockProvider === undefined
      ? resolveDefaultLockProvider()
      : options.lockProvider;
  return withPairFinalizeLock(lockProvider, () =>
    finalizePairCodeSuccessLocked(options),
  );
};

/** The actual finalize pipeline, run under the cross-tab single-flight
 *  lock. Split from `finalizePairCodeSuccess` so the lock wrapper stays
 *  shallow + the test seam (passing `lockProvider: null` opts out of
 *  serialisation while still exercising every other behavior). */
const finalizePairCodeSuccessLocked = async (
  options: PairCodeSuccessOptions,
): Promise<PairCodeSuccessResult> => {
  // 0. Codex 2026-05-28 HIGH #7-symmetric fold — reject stale-form /
  //    multi-tab re-pair attempts inside the lock so the read-then-
  //    check sequence is atomic with respect to other webclient tabs.
  //
  //    Vector: the webclient is multi-tab. Two tabs each boot unpaired
  //    + mount the pair form; one tab submits + lands paired; the
  //    SECOND tab can still submit in the short window before the
  //    credential-free pair-tab signal/poll dismisses its in-memory form.
  //    Inside the lock the second tab observes
  //    the fully-written `webclient_token` from the first tab's
  //    finalize and short-circuits with the tagged error so the
  //    user's onPaired catch arm can render the reload fallback while the
  //    passive convergence path verifies and adopts the durable pair.
  //    Without the entrance guard, the second tab would proceed
  //    through passport.fetch + wrap + the 5-field write sequence over
  //    a store that already has a valid `webclient_token`. With the
  //    new step-5 write order `pair_metadata → cert_pin_state →
  //    server_url → server_public_key → webclient_token`, an
  //    intermediate write failure (say `server_public_key` failing to
  //    overwrite) would leave the store in a Frankenstein state:
  //    pair_metadata + cert_pin_state + server_url overwritten with
  //    NEW values, server_public_key still at the OLD value,
  //    webclient_token still at the OLD value bound to the OLD AAD.
  //    On next boot the strict discriminant (server_url +
  //    server_public_key + webclient_token all non-null) stays
  //    satisfied, but unwrap-time AAD reconstruction uses the OLD
  //    token_id + NEW server_url + OLD server_public_key → AEAD
  //    mismatch on server_url → unwrap fails → the user is pushed
  //    into the clear-this-browser recovery flow with no warning.
  //
  //    HIGH #8-symmetric fold — the `localStore.get(...)` calls
  //    themselves can reject (IDB IO error, browser storage
  //    corruption, etc.). Catch + tag as
  //    `pair_code_success_persist_failed` rather than letting the
  //    throw escape `finalizePairCodeSuccess`'s tagged-result
  //    contract; the host's `onPaired` catch arm would otherwise
  //    surface a generic "unhandled rejection" string instead of the
  //    closed-list error copy.
  //
  //    Strict-triple check (Codex 2026-05-28 P5 finding B fold) — the
  //    already-paired condition matches `hydratePairState`'s strict
  //    discriminant in [[webclient-bootstrap]] lines 576-582:
  //    server_url + server_public_key + webclient_token ALL non-null.
  //    Checking webclient_token alone would lock a user out of
  //    recovery from a corruption path where token is present but
  //    one of the other strict fields is missing (the bootstrap
  //    mounts the pair form for that partial state; the user must
  //    be able to re-finalize from it). Stale `pair_metadata` /
  //    `cert_pin_state` from a prior pair don't gate the guard —
  //    the step-5 write sequence overwrites both.
  let existingToken: WebclientTokenRecord | null;
  let existingServerUrl: string | null;
  let existingServerPublicKey: string | null;
  try {
    [existingToken, existingServerUrl, existingServerPublicKey] =
      await Promise.all([
        options.localStore.get('webclient_token'),
        options.localStore.get('server_url'),
        options.localStore.get('server_public_key'),
      ]);
  } catch (err) {
    return {
      ok: false,
      error: 'pair_code_success_persist_failed',
      detail: `local-store read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const alreadyPaired =
    existingToken !== null &&
    existingServerUrl !== null &&
    existingServerPublicKey !== null;
  if (alreadyPaired) {
    return {
      ok: false,
      error: 'pair_code_success_already_paired',
      detail:
        'strict pair triple already populated — another tab finished pairing first; adopt that durable pair or reload as fallback',
    };
  }

  const wsServerUrl = normaliseServerUrlToWs(options.serverUrl);
  if (wsServerUrl === null) {
    return {
      ok: false,
      error: 'pair_code_success_invalid_server_url',
      detail: 'server URL must be http://, https://, ws://, or wss://',
    };
  }

  // 1. Passport projection. New servers return this directly from
  //    `/auth/pair`; legacy servers fall back to a one-shot
  //    `passport.fetch`. When a server-issued token_id is present, the
  //    one-shot auth bearer must use the canonical structured shape.
  let projection: { passport: unknown };
  if (options.passport !== undefined) {
    projection = { passport: options.passport };
  } else {
    const authBearer = options.token_id
      ? `${options.token_id}.${options.bearer}`
      : options.bearer;
    try {
      projection = await options.invokePassportFetch({
        server_url: wsServerUrl,
        bearer: authBearer,
      });
    } catch (err) {
      return {
        ok: false,
        error: 'pair_code_success_passport_failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const fields = extractPassportFields(projection.passport);
  if (!fields) {
    return {
      ok: false,
      error: 'pair_code_success_server_response_invalid',
      detail: 'passport projection missing identity.server_public_key',
    };
  }

  // 2. Use the server-issued token_id when present; legacy servers keep
  //    the old local-only id fallback.
  const mintId = options.mintTokenId ?? defaultMintTokenId;
  const token_id = options.token_id ?? mintId();

  // 3. Build AAD + wrap bearer. The AAD binds the ciphertext to the
  //    canonical WS URL — both wrap and unwrap reconstruct from the
  //    persisted `server_url` value (which is the WS form), so a
  //    later `wsServerUrl !== persisted server_url` would surface as
  //    an AEAD mismatch at unwrap time.
  const aad: WebclientTokenAad = {
    token_id,
    server_url: wsServerUrl,
    server_public_key: fields.server_public_key,
  };

  let tokenRecord: WebclientTokenRecord;
  try {
    tokenRecord = await options.tokenStore.wrap({
      token_id,
      bearer: options.bearer,
      aad,
    });
  } catch (err) {
    return {
      ok: false,
      error: 'pair_code_success_persist_failed',
      detail: `token-store wrap: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Derive pair_metadata + cert_pin_state
  const paired_at = options.now ? options.now() : Date.now();
  const pair_metadata: WebclientPairMetadata = {
    paired_at,
    server_passport_fingerprint: fields.server_public_key,
    server_handle_at_pair: fields.current_handle,
    ...(options.instanceId !== undefined && options.instanceId.length > 0
      ? { instance_id: options.instanceId }
      : {}),
  };
  const cert_pin_state = deriveCertPinFromPassport(
    fields.cert_fingerprint,
    fields.cert_expires_at,
  );

  // 5. Select the profile + write its mutable fields. Per-key; the local-store
  //    has no transaction primitive.
  //
  //    Codex 2026-05-28 HIGH #2 symmetric fold — mirrors the bridge's
  //    HIGH #2 fix in [[apps/bridge/src/popup/pair-completion]]
  //    (commit `bf7aab2a`). `webclient_token` writes LAST so the
  //    bootstrap's `hydratePairState` strict discriminant
  //    (`server_url` + `server_public_key` + `webclient_token` all
  //    non-null — see `webclient-bootstrap.ts` lines 576-582) only
  //    flips after every other field has landed.
  //
  //    The webclient has no `chrome.storage.onChanged` analogue that
  //    fires off `webclient_token` transitions (unlike the bridge,
  //    whose listener flips the action's `default_popup` → side-panel
  //    on that specific key), but the structural vulnerability is the
  //    same: a mid-write failure on `pair_metadata` / `cert_pin_state`
  //    after the three strict fields had already landed would leave
  //    the NEXT page load entering paired mode with the inspector copy
  //    + cert-pin overlay degraded (Settings → Server "you paired to
  //    …'s server" derives from `pair_metadata.server_handle_at_pair`;
  //    the cert-pin watcher reads `cert_pin_state` at boot per the
  //    `webclient-bootstrap.ts` DD#10 cert-pin poll comments). With
  //    `webclient_token` last, a failure mid-sequence leaves
  //    `webclient_token === null` → strict discriminant rejects →
  //    unpaired form re-renders → user retries cleanly. Stale residual
  //    fields from a prior incomplete pair get overwritten by this write
  //    sequence. A selected profile can already carry an OLD complete token
  //    when an add-server attempt resolves to a URL already in the roster, so
  //    that token is cleared immediately after selection; otherwise a later
  //    write failure could leave the old token completing a mixed generation.
  //    The discriminant only flips again on the final token set.
  //
  //    Order: ensureProfile → clear stale token → pair_metadata →
  //    cert_pin_state → server_public_key → webclient_token. Selecting FIRST
  //    matters when an add-server attempt resolves to a URL already in the
  //    roster: any pending record is retired by `ensureProfile`, so fields
  //    written before it would be discarded with that record. The selected
  //    profile carries the canonical WS form so the bootstrap's long-lived
  //    ws-client opens against the same endpoint the passport-fetch one-shot
  //    just authenticated against. The bare `server_url` write remains only
  //    for older callers that do not yet expose the roster surface.
  try {
    if (options.profileStore !== undefined) {
      await options.profileStore.ensureProfile(wsServerUrl);
    } else {
      await options.localStore.set('server_url', wsServerUrl);
    }
    await options.localStore.remove('webclient_token');
    await options.localStore.set('pair_metadata', pair_metadata);
    await options.localStore.set('cert_pin_state', cert_pin_state);
    await options.localStore.set('server_public_key', fields.server_public_key);
    await options.localStore.set('webclient_token', tokenRecord);
  } catch (err) {
    return {
      ok: false,
      error: 'pair_code_success_persist_failed',
      detail: `local-store write: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    server_url: wsServerUrl,
    server_public_key: fields.server_public_key,
    token_id,
    pair_metadata,
  };
};
