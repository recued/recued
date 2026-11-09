/** D-169 P1.5 — bridge post-pair persistence substrate.
 *
 *  Closes the gap between the realm bearer `/auth/pair` returned to the
 *  service worker's pairing session ([[createBridgeWorkerPairing]]) and
 *  the 5 closed-list chrome.storage fields the SW bootstrap's `paired` discriminant
 *  gates on (`server_url` + `webclient_token` + `server_public_key`,
 *  with `pair_metadata` + `cert_pin_state` for the inspector +
 *  cert-pin overlap stack).
 *
 *  Verbatim-shape port of [[apps/webclient/src/auth/pair-code-success]]
 *  modulo the IDB key constants — the bridge SW already constructed
 *  its `WebclientTokenStore` over the bridge-scoped AES-GCM key store
 *  in `service-worker-entry.ts`, so we wrap with the SAME interface
 *  the webclient uses (Slice 2B's substrate alignment).
 *
 *  ── Pipeline ───────────────────────────────────────────────────────
 *    1. Normalise the user-typed `server_url` → canonical `ws(s)://…/ws`
 *       form. The bridge's long-lived WS opens against this; the
 *       `/auth/pair` POST used the raw HTTP form (`http(s)://`)
 *       so the user-typed value is the HTTP shape. Same `normaliseServerUrlToWs`
 *       rules as the webclient (Codex 2026-05-18 P5 R1 critical fold).
 *    2. Open a one-shot authenticated WS, call the `passport.fetch`
 *       rpc, learn `server_public_key` + `cert_fingerprint` +
 *       `cert_expires_at` + `current_handle`. This is the only way to
 *       discover the server's identity public key on the receive side;
 *       there's no HTTP introspection endpoint.
 *    3. Mint a client-side UUIDv4 `token_id`. The `/auth/pair` response
 *       does NOT include one (the realm bearer is opaque server-side);
 *       we derive a stable id locally for the AES-GCM AAD binding +
 *       the inspector + future re-pair flows. Mirror of the webclient's
 *       DD#2 ("token_id is client-minted, not server-issued").
 *    4. Build the AAD triple + wrap the bearer via `tokenStore.wrap`.
 *       Plaintext never persists — the wrapped record is what lands
 *       in chrome.storage.
 *    5. Derive `WebclientPairMetadata` (paired_at +
 *       server_passport_fingerprint + server_handle_at_pair) + the
 *       optional `WebclientCertPinState` (null when EITHER cert field
 *       is missing — LAN-only servers have no TLS cert yet).
 *    6. Persist all 5 fields per-key. Order matches the webclient
 *       (server_url → server_public_key → webclient_token →
 *       pair_metadata → cert_pin_state) so a mid-write failure leaves
 *       the bridge's `paired` check rejecting (the three strict fields
 *       are written first; `webclient_token` writes flip the boot's
 *       paired state). Past that, missing `pair_metadata` /
 *       `cert_pin_state` degrade gracefully (inspector renders null;
 *       cert-pin verify path seeds on the next reconnect via the
 *       existing passport-fetch verify pipeline).
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Pure substrate. The service worker's pairing session
 *  ([[createBridgeWorkerPairing]], `worker-pairing.ts`) owns the wiring;
 *  this module just drives the pipeline against injected collaborators
 *  (local store, token store, passport-fetch invoker). Tests inject
 *  in-memory fakes for every collaborator.
 *
 *  DD#2 — No recovery key reaches this module. The pairing session sends
 *  one to `/auth/pair` when the user typed it and keeps it nowhere; the
 *  sealed-verifier sentinel (D-156 P9) would be the only reason to pass
 *  it on, and it is not built.
 *
 *  DD#3 — Starting the paired runtime is the pairing session's job, NOT
 *  this module's. Finalize returns `{ ok: true, … }`; the session then
 *  starts the worker's connection (`onPaired`). Routing it through here
 *  would need the worker's runtime at the substrate layer, which the test
 *  harness doesn't have (and shouldn't — the substrate's contract is pure
 *  pipeline).
 *
 *  DD#4 — Errors surface as tagged results, never thrown. The pairing
 *  session turns them into the outcome the side panel renders. */

import type {
  WebclientCertPinState,
  WebclientPairMetadata,
  WebclientTokenRecord,
} from '@recued/contracts';

import { isInsecurePublicServerUrl } from './server-url-security.js';
import type { BridgeLocalStore } from '../storage/local-store.js';
import type {
  WebclientTokenAad,
  WebclientTokenStore,
} from '../storage/token-store.js';

// ════════════════════════════════════════════════════════════════
// Result shape
// ════════════════════════════════════════════════════════════════

/** What `finalizeBridgePair` returns to the worker's pairing session
 *  (`worker-pairing.ts`). */
export type BridgePairFinalizeResult =
  | {
      ok: true;
      /** Persisted canonical WS server URL (post-normalisation). */
      server_url: string;
      /** Client-minted UUIDv4 the AAD binds against — diagnostics only. */
      token_id: string;
    }
  | {
      ok: false;
      error: BridgePairCompletionErrorCode;
      detail?: string;
    };

// ════════════════════════════════════════════════════════════════
// Error taxonomy
// ════════════════════════════════════════════════════════════════

/** Closed-list error codes. Mirror the webclient's
 *  `PairCodeSuccessErrorCode` plus the bridge-specific
 *  `pair_completion_already_paired` (the bridge rejects re-pair to
 *  protect existing credentials; the webclient mounts a different
 *  pair UI altogether when an entry exists). */
export type BridgePairCompletionErrorCode =
  | 'pair_completion_passport_failed'
  | 'pair_completion_persist_failed'
  | 'pair_completion_server_response_invalid'
  | 'pair_completion_invalid_server_url'
  | 'pair_completion_already_paired';

/** User-facing copy. The pairing session returns the error code; the pair
 *  host maps it here.
 *
 *  ⛔ A RETRYABLE ENTRY IS A REASON, NOT AN INSTRUCTION. By the time any of
 *  these can happen, `/auth/pair` has already spent the single-use code. The
 *  host shows a retryable entry as "This bridge didn't finish setting up:
 *  <reason>. Select Finish pairing…", and its button retries with the reply
 *  the worker holds. These used to end "Reload and try again", and the retry re-sent
 *  the spent code: the server answered `invalid_code` and the user was told
 *  the code was wrong (a Chrome Web Store rejection, 2026-10-09). The entries
 *  in {@link BRIDGE_PAIR_COMPLETION_FINAL_ERRORS} are whole messages, shown
 *  alone, because finishing again cannot help. */
export const BRIDGE_PAIR_COMPLETION_ERROR_COPY: Readonly<
  Record<BridgePairCompletionErrorCode, string>
> = {
  pair_completion_passport_failed:
    "Recued couldn't reach your server to confirm who it is",
  pair_completion_persist_failed:
    "Recued couldn't save the sign-in in this browser",
  pair_completion_server_response_invalid:
    "your server's identity details couldn't be read",
  pair_completion_invalid_server_url:
    "Recued couldn't turn that server address into a connection. Pair again with the address your server prints and a new pairing code.",
  pair_completion_already_paired:
    'This bridge is already paired. To pair it again, open the side panel and disconnect it in Settings first.',
};

/** Errors that the same server reply would hit again on every retry: a URL
 *  the WS form rejects, and a bridge that already holds a DIFFERENT pairing
 *  (a retry of the SAME pairing is answered `ok` — see `finalizeBridgePair`
 *  step 0). The pairing session drops the accepted pairing on these instead
 *  of offering to finish it. */
export const BRIDGE_PAIR_COMPLETION_FINAL_ERRORS: ReadonlySet<BridgePairCompletionErrorCode> =
  new Set<BridgePairCompletionErrorCode>([
    'pair_completion_invalid_server_url',
    'pair_completion_already_paired',
  ]);

// ════════════════════════════════════════════════════════════════
// Server-URL normalisation (port of webclient `normaliseServerUrlToWs`)
// ════════════════════════════════════════════════════════════════

/** Convert the user-typed HTTP server URL into the canonical WS
 *  endpoint the bridge's WS transport expects.
 *
 *  Rules (verbatim port of webclient's pair-code-success.ts):
 *    - `http://`  → `ws://`
 *    - `https://` → `wss://`
 *    - Already-`ws(s)://` URLs pass through.
 *    - Trailing `/` is stripped before path inspection.
 *    - Path ending with `/ws` is preserved; otherwise `/ws` is appended.
 *
 *  Returns null when the URL is structurally invalid so the
 *  orchestrator surfaces `pair_completion_invalid_server_url` without
 *  touching the network or chrome.storage. */
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
  // D-169 bridge security hunt, F2 — require TLS for PUBLIC hosts. A public
  // `ws://` carries the bearer token in the connect-URL query string AND
  // accepts on-path command-frame injection over the open internet. Plaintext
  // is permitted only for hosts the public internet cannot route to (loopback,
  // RFC1918, link-local, CGNAT, mDNS `.local`) — preserving the supported
  // no-TLS home/LAN self-host case — via the shared posture the
  // `/auth/pair` POST also enforces (so the two can't drift). Reject otherwise
  // (null → `pair_completion_invalid_server_url`); use `wss://` for public.
  if (isInsecurePublicServerUrl(withProtocol)) {
    return null;
  }
  const protoEnd = withProtocol.indexOf('://') + 3;
  const remainder = withProtocol.slice(protoEnd);
  if (remainder.length === 0) return null;
  const trimmedRemainder = remainder.endsWith('/')
    ? remainder.slice(0, -1)
    : remainder;
  if (trimmedRemainder.length === 0) return null;
  const pathIdx = trimmedRemainder.indexOf('/');
  if (pathIdx === 0) return null;
  const protocol = withProtocol.slice(0, protoEnd);
  if (pathIdx < 0) {
    return `${protocol}${trimmedRemainder}/ws`;
  }
  const path = trimmedRemainder.slice(pathIdx);
  if (path === '/ws' || path.endsWith('/ws')) {
    return `${protocol}${trimmedRemainder}`;
  }
  return `${protocol}${trimmedRemainder}/ws`;
};

// ════════════════════════════════════════════════════════════════
// Passport-projection extraction
// ════════════════════════════════════════════════════════════════

interface ExtractedPassportFields {
  server_public_key: string;
  cert_fingerprint: string | undefined;
  cert_expires_at: number | undefined;
  current_handle: string;
}

/** Pluck the four fields the finalize path needs from the passport
 *  projection. Returns null when the projection is structurally
 *  invalid (missing `identity.server_public_key`, non-string public
 *  key, etc.) so the orchestrator surfaces
 *  `pair_completion_server_response_invalid` rather than persisting a
 *  half-baked pair state. Port of webclient `extractPassportFields`. */
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
    typeof p.identity?.current_handle === 'string'
      ? p.identity.current_handle
      : '';
  const cf = p.network?.cert_fingerprint;
  const ce = p.network?.cert_expires_at;
  return {
    server_public_key,
    cert_fingerprint:
      typeof cf === 'string' && cf.length > 0 ? cf : undefined,
    cert_expires_at:
      typeof ce === 'number' && Number.isFinite(ce) ? ce : undefined,
    current_handle,
  };
};

/** Derive `WebclientCertPinState` from the passport projection. Returns
 *  null when EITHER cert field is missing so a LAN-only server (no
 *  cert yet) doesn't carry a stale pin from a prior pair. Port of
 *  webclient `deriveCertPinFromPassport`. */
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

// ════════════════════════════════════════════════════════════════
// Token id mint (UUID seam — Codex P1 fold parity with webclient)
// ════════════════════════════════════════════════════════════════

const defaultMintTokenId = (): string => {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  return `bridge-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e9,
  ).toString(36)}`;
};

// ════════════════════════════════════════════════════════════════
// Passport-fetch invoker contract
// ════════════════════════════════════════════════════════════════

/** Signature of the one-shot passport.fetch invoker the finalize path
 *  drives. Production builds this from the bridge's `WsTransportFactory`
 *  (see [[pair-passport-invoker]]); tests inject an in-memory fake. */
export interface BridgePairPassportInvoker {
  (args: { server_url: string; bearer: string }): Promise<{ passport: unknown }>;
}

// ════════════════════════════════════════════════════════════════
// Orchestrator
// ════════════════════════════════════════════════════════════════

export interface FinalizeBridgePairOptions {
  /** Server URL the user typed (raw HTTP shape). */
  serverUrl: string;
  /** Realm bearer from `/auth/pair`. */
  bearer: string;
  /** Durable server-issued token id from `/auth/pair`. When absent,
   *  the legacy fallback mints a local id and uses raw bearer auth. */
  token_id?: string;
  /** Passport projection returned directly by `/auth/pair`. When
   *  absent, finalize falls back to one-shot `passport.fetch`. */
  passport?: unknown;
  /** The instance id sent to `/auth/pair` as `instanceId` — the server
   *  stamped it on the token. Recorded in `pair_metadata.instance_id`, as
   *  the webclient does. */
  instanceId?: string;
  /** Bridge local store the 5 fields write into. */
  localStore: BridgeLocalStore;
  /** Token store that wraps the bearer with the bridge's non-extractable
   *  AES-GCM key (constructed in `service-worker-entry.ts`). */
  tokenStore: WebclientTokenStore;
  /** One-shot passport.fetch invoker — production wires a closure over
   *  the bridge's `WsTransportFactory`; tests inject an in-memory fake. */
  invokePassportFetch: BridgePairPassportInvoker;
  /** Optional clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Optional id-mint seam (tests). Defaults to `randomUUID`. */
  mintTokenId?: () => string;
}

/** Drive passport-fetch → wrap → write-5. Never throws — every failure
 *  surfaces as a tagged result the pairing session turns into the outcome
 *  the side panel renders. */
export const finalizeBridgePair = async (
  options: FinalizeBridgePairOptions,
): Promise<BridgePairFinalizeResult> => {
  // 0. Codex 2026-05-28 HIGH #7 fold — reject re-pair attempts.
  //    The pairing session refuses a `start` on a paired bridge before
  //    anything is posted, so only a race reaches this. Without it, a
  //    second pairing finalizing over a paired bridge would hit a
  //    vulnerable mid-write window where
  //    a transient storage error after `set('server_url', …)` /
  //    `set('server_public_key', …)` leaves the strict paired
  //    discriminant true with the OLD bearer bound to a stale AAD
  //    triple. Rejecting at the entrance preserves the existing pair
  //    + points the user at the Settings → "Disconnect this bridge"
  //    affordance. Pre-launch zero-installs there's no migration; the
  //    documented re-pair flow is wipe-then-pair (per task scope
  //    "multi-pair / re-pair flows out of scope" — D-156 P9 / future).
  //
  //    Codex 2026-05-28 HIGH #8 fold — the storage read itself can
  //    reject (chrome.storage IO error / disposed context). Catch
  //    + tag as `pair_completion_persist_failed` so the session keeps
  //    the accepted reply for Finish pairing rather than stranding the
  //    user with a consumed pairing code.
  let existingToken: WebclientTokenRecord | null;
  try {
    existingToken = await options.localStore.get('webclient_token');
  } catch (err) {
    return {
      ok: false,
      error: 'pair_completion_persist_failed',
      detail: `local-store read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (existingToken !== null) {
    // A second finish of THIS pairing whose first finalize landed every
    // write but whose outcome was lost (the worker stopped before it could
    // drop the held reply, say). `webclient_token` is written LAST, so
    // finding it under the same server-issued id means every write landed:
    // answer as that attempt would have, so the worker starts its paired
    // runtime instead of reporting the user's own pairing as being in the
    // way. Only a server-issued id can match — a legacy client-minted one
    // is new on every attempt.
    if (options.token_id !== undefined && existingToken.token_id === options.token_id) {
      let storedUrl: string | null;
      try {
        storedUrl = await options.localStore.get('server_url');
      } catch (err) {
        return {
          ok: false,
          error: 'pair_completion_persist_failed',
          detail: `local-store read: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (storedUrl !== null) {
        return { ok: true, server_url: storedUrl, token_id: options.token_id };
      }
    }
    return {
      ok: false,
      error: 'pair_completion_already_paired',
      detail:
        'webclient_token already populated — disconnect from Settings before pairing again',
    };
  }

  // 1. Normalise the user-typed URL → canonical WS form.
  const wsServerUrl = normaliseServerUrlToWs(options.serverUrl);
  if (wsServerUrl === null) {
    return {
      ok: false,
      error: 'pair_completion_invalid_server_url',
      detail: 'a server address must start with http://, https://, ws://, or wss://',
    };
  }

  // 2. Passport projection. New servers return this directly from
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
        error: 'pair_completion_passport_failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const fields = extractPassportFields(projection.passport);
  if (!fields) {
    return {
      ok: false,
      error: 'pair_completion_server_response_invalid',
      detail: 'passport projection missing identity.server_public_key',
    };
  }

  // 3. Use the server-issued token_id when present; legacy servers keep
  //    the old local-only id fallback.
  const mintId = options.mintTokenId ?? defaultMintTokenId;
  const token_id = options.token_id ?? mintId();

  // ⚠ NO `server_url` IN THE AAD. v2 deliberately omits it: binding the
  // ciphertext to the address meant a server that MOVED could never be
  // unwrapped again, and it never defended against tampering — the reader
  // rebuilds the AAD from the same store an attacker would have written to.
  const aad: WebclientTokenAad = {
    token_id,
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
      error: 'pair_completion_persist_failed',
      detail: `token-store wrap: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 5. Derive pair_metadata + cert_pin_state.
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

  // 6. Persist all 5 fields. Per-key; the local-store has no
  //    transaction primitive.
  //
  //    Codex 2026-05-28 HIGH #2 fold — `webclient_token` writes LAST
  //    so the bootstrap's `paired` discriminant (server_url +
  //    server_public_key + webclient_token all non-null) only flips
  //    after every other field has landed. The side panel watches the
  //    same three fields through `chrome.storage.onChanged` and switches
  //    from the pair form to its paired sections when they are all
  //    present — so a mid-write failure on `pair_metadata` /
  //    `cert_pin_state` would otherwise leave a paired-but-half-populated
  //    bridge with the pair form already gone.
  //
  //    The remove-first variant we briefly experimented with was
  //    retired alongside HIGH #7 — the entrance guard at step 0
  //    rejects re-pair attempts so the storage state is guaranteed to
  //    start with `webclient_token: null` (the strict discriminant is
  //    already false). Stale residual `pair_metadata` /
  //    `cert_pin_state` from a prior incomplete pair get overwritten
  //    by this write sequence; the `paired` discriminant only flips
  //    on the final `webclient_token` set.
  //
  //    Order: pair_metadata → cert_pin_state → server_url →
  //    server_public_key → webclient_token. If ANY write fails, the
  //    bootstrap's strict discriminant rejects + the next retry
  //    overwrites the partial fields cleanly. The webclient's
  //    pair-code-success.ts has the symmetric vulnerability — that's
  //    a follow-on; here we only fix the bridge.
  try {
    await options.localStore.set('pair_metadata', pair_metadata);
    await options.localStore.set('cert_pin_state', cert_pin_state);
    await options.localStore.set('server_url', wsServerUrl);
    await options.localStore.set('server_public_key', fields.server_public_key);
    await options.localStore.set('webclient_token', tokenRecord);
  } catch (err) {
    return {
      ok: false,
      error: 'pair_completion_persist_failed',
      detail: `local-store write: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    server_url: wsServerUrl,
    token_id,
  };
};
