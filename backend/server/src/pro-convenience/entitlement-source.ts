/** D-175 P8b — Pro entitlement source.
 *
 *  Resolves the server's Pro entitlement from the stored recued.com account
 *  binding credential. The auth Worker mints a short-lived Ed25519-signed
 *  claim; this module verifies that claim locally (signature + TTL + account
 *  + server fingerprint) before returning `entitled`. The raw claim token is
 *  kept inside this boundary and is never emitted by `pro_convenience.status`.
 *
 *  Ownership-only semantics (owner-ratified, D-175 P8b option C). The mint is
 *  ownership-only — it returns a claim for any CURRENTLY-bound owner without
 *  deciding paid vs free, so a successful, well-formed claim resolves
 *  `entitled` even for a Free account. `entitled` here means "bound + owned";
 *  the authoritative Pro gate is the cloud DDNS/ACME `subscription_active`
 *  flag, enforced downstream when the server actuates. `not_entitled` is kept
 *  as a forward-compatible state (the provisioner maps it to `inactive-free`)
 *  for a future entitlement-aware mint — today's mint never returns it.
 */

import {
  parseProHandleAnchor,
  type ProEntitlementClaim,
  type ProHandleAnchor,
} from '@recued/contracts';
import { ed25519Verify, type StoredAccountBinding } from '../keys/index.js';
import { makeBoundedOriginHttpFetcher } from '../bounded-origin-http-fetcher.js';
import { CLOUD_APEX_DEFAULT, resolveCloudApex } from '../account-binding/exchange-url.js';

/** The resolved Pro entitlement — SECRET-FREE. NEVER carries the
 *  `server_scoped_credential` nor the raw signed claim token; only the
 *  coarse state + (when entitled) the claim's expiry.
 *
 *  - `entitled` — a verified, unexpired ownership claim (bound + owned). Pro
 *    is enforced downstream by the cloud `subscription_active` gate (header).
 *  - `not_entitled` — forward-compat: a future entitlement-aware mint
 *    reporting Free. The current ownership-only mint never returns it.
 *  - `unbound` — no binding credential to resolve against.
 *  - `pending` — retained for older tests / transitional callers; the
 *    production composition now uses the HTTP source below.
 *  - `unavailable` — a transient failure (network), or a present-but-
 *    expired / signature-invalid claim. The caller fails CLOSED. */
export type ProEntitlementResolution =
  | {
      state: 'entitled';
      expires_at?: number;
      handle_anchor?: ProHandleAnchor;
      /** The account's current marketplace handle, from INSIDE the verified
       *  claim — the only fresh, authenticated view the server gets of a rename.
       *  Absent ⇒ no handle claimed, or a cloud older than the field; either way
       *  the caller keeps using its binding snapshot. */
      publisher_handle?: string;
    }
  | { state: 'not_entitled' }
  | { state: 'unbound' }
  /** The cloud verified our credential and says this account no longer owns
   *  this server — unbound, deleted, or rebound elsewhere. TERMINAL, and
   *  distinct from `unavailable` because the remedies are opposite: this one
   *  needs the owner to reconnect the server, and no amount of waiting helps.
   *
   *  ⚠ NOT DERIVED FROM `credential_invalid`, which means five things — two of
   *  them 400s raised before a credential is even read, i.e. OUR bug. The cloud
   *  emits a purpose-built `server_disowned` after the HMAC verifies; anything
   *  less precise would announce a disconnection for a serialization fault. */
  | { state: 'disowned' }
  | { state: 'pending'; reason: 'entitlement_endpoint_pending' }
  | { state: 'unavailable'; reason: string };

/** The seam the provisioner gates on. One method; the provisioner only
 *  calls it once it has confirmed the server is bound, so an
 *  implementation may assume a credential is present (and surface
 *  `unbound` defensively if it isn't). */
export interface ProEntitlementSource {
  /** Resolve the current Pro entitlement off the stored binding
   *  credential. Implementations MUST fail closed — a network error, an
   *  expired claim, or a signature that fails Ed25519 verification all
   *  resolve to `unavailable`, NEVER `entitled`. */
  resolve(): Promise<ProEntitlementResolution>;
}

export interface VerifiedProEntitlementClaim {
  /** SECRET bearer-like claim token. Never put in status/audit details. */
  entitlement_claim: string;
  claims: ProEntitlementClaim;
  expires_at: number;
}

export interface ClaimBackedProEntitlementSource extends ProEntitlementSource {
  /** Resolve the same claim for the existing cert-stack `ProAuthResolver`.
   *  This is intentionally separate from `resolve()` so the status surface
   *  remains secret-free while actuation can use the one existing bearer
   *  path instead of a second provisioner. */
  resolveClaim(): Promise<VerifiedProEntitlementClaim | null>;
}

/** Transitional stub retained for harnesses that still pin the old pending
 *  branch. Production no longer wires this source. */
export const createPendingProEntitlementSource = (): ProEntitlementSource => ({
  async resolve() {
    return { state: 'pending', reason: 'entitlement_endpoint_pending' };
  },
});

export interface RealProEntitlementSourceDeps {
  /** Reads the stored account binding. The credential MUST NOT escape the
   *  source except as the Worker's server-to-server mint request. */
  loadBinding: () => StoredAccountBinding | null;
  /** Resolves the auth-Worker entitlement-mint endpoint URL. */
  getEndpointUrl: () => string | undefined;
  /** Ed25519 SPKI DER base64 public key that verifies Worker claims. */
  getPublicKeyB64: () => string | undefined;
  /** `fetch` implementation. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout (ms). Default 10s. */
  timeoutMs?: number;
  /** Response ceiling (bytes). Defaults to the shared provider API limit. */
  maxResponseBytes?: number;
  /** Clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
}

const ENTITLEMENT_PREFIX = 'proent.v1';
const DEFAULT_TIMEOUT_MS = 10_000;
const CLAIM_FUTURE_SKEW_MS = 60 * 1000;
export const PRO_ENTITLEMENT_MINT_PATH = '/v1/account/entitlement/mint';

export interface ResolveProEntitlementMintUrlOptions {
  override?: string;
  /** ⛔ `cloudBaseUrl` WAS HERE AND WAS IGNORED — REMOVED 2026-08-30. It was kept "for
   *  callers" with a comment saying it is no longer read, and SIX call sites went on
   *  passing it as if it selected the environment — including both live-drive tools and
   *  the entitlement checker's own negative control, which therefore compared production
   *  against production and could never have caught the shared key it exists to catch. A
   *  retained-but-ignored option is not a compatibility shim, it is a control that does
   *  nothing; deleting it turns every such call into a compile error. Use `cloudApex`. */
  /** Apex override for tests; production reads `RECUED_CLOUD_APEX`. */
  cloudApex?: string;
}

export const resolveProEntitlementMintUrl = (
  options: ResolveProEntitlementMintUrlOptions = {},
): string => {
  const override = options.override?.trim();
  if (override) return override;
  // Single source of truth with the binding exchange — same Worker, same apex.
  const apex = options.cloudApex?.trim() || resolveCloudApex();
  return `https://auth.${apex}${PRO_ENTITLEMENT_MINT_PATH}`;
};

/** The trust anchor for `proent.v1` claims: the Ed25519 SPKI-DER public half
 *  (standard base64) of the auth-Worker's `PRO_ENTITLEMENT_SIGNING_PRIVATE_KEY_B64`.
 *
 *  These are CONSTANTS, not secrets and not operator config. A public key is
 *  safe to ship, and it MUST ship: `resolveClaim` returns null when it has no
 *  key, which fails closed SILENTLY (entitlement `unavailable` → no reserve, no
 *  DDNS, no ACME, no error surfaced). Leaving this to an env var would mean
 *  every self-hosted server needs a hand-set variable or Pro simply never works.
 *
 *  Keyed per environment and selected by the SAME `isRecued2CloudHost` switch
 *  `resolveProEntitlementMintUrl` uses, so the key a server verifies with always
 *  belongs to the Worker it actually minted from — the two can never disagree.
 *
 *  ⚠ ROTATION is a two-sided change: `wrangler secret put
 *  PRO_ENTITLEMENT_SIGNING_PRIVATE_KEY_B64 --env <env>` AND the matching
 *  constant here, shipped together. A mismatch fails closed (claims stop
 *  verifying), never open. Generated 2026-08-05; see
 *  D-175. */
const PRO_ENTITLEMENT_PUBLIC_KEY_PROD =
  'MCowBQYDK2VwAyEAc7SOi3TcGaYFCutsbVZzNEkJDsmWFBILqPp/HxRhp40=';

export interface ResolveProEntitlementPublicKeyOptions {
  /** `RECUED_PRO_ENTITLEMENT_PUBLIC_KEY_B64` — wins when set. Kept so a local
   *  rig / a private deployment can point at its own signer without a rebuild. */
  override?: string;
  /** ⛔ `cloudBaseUrl` WAS HERE AND WAS IGNORED — REMOVED 2026-08-30. It was kept "for
   *  callers" with a comment saying it is no longer read, and SIX call sites went on
   *  passing it as if it selected the environment — including both live-drive tools and
   *  the entitlement checker's own negative control, which therefore compared production
   *  against production and could never have caught the shared key it exists to catch. A
   *  retained-but-ignored option is not a compatibility shim, it is a control that does
   *  nothing; deleting it turns every such call into a compile error. Use `cloudApex`. */
  /** Apex override for tests; production reads `RECUED_CLOUD_APEX`. */
  cloudApex?: string;
}

export const resolveProEntitlementPublicKey = (
  options: ResolveProEntitlementPublicKeyOptions = {},
): string => {
  const override = options.override?.trim();
  if (override) return override;
  // ⛔⛔ THE APEX AND THE TRUST ANCHOR ARE ONE DECISION, SO REFUSE THE HALF
  // CONFIGURATION. A mirror mints from `auth.<its apex>` but would verify with
  // the PROD key, so every claim fails to verify — closed, but silently and a
  // long way from the cause. The old code kept a second hardcoded key in step
  // with a host sniff; now that both are configuration, the pairing has to be
  // enforced rather than assumed.
  const apex = options.cloudApex?.trim() || resolveCloudApex();
  if (apex !== CLOUD_APEX_DEFAULT) {
    throw new Error(
      `RECUED_CLOUD_APEX is '${apex}', so entitlements are minted by that apex's `
        + 'auth Worker, but no RECUED_PRO_ENTITLEMENT_PUBLIC_KEY_B64 is set — every '
        + 'claim would fail to verify against the default trust anchor. Set the '
        + "public half of that Worker's PRO_ENTITLEMENT_SIGNING_PRIVATE_KEY_B64.",
    );
  }
  return PRO_ENTITLEMENT_PUBLIC_KEY_PROD;
};

const base64UrlToBytes = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
};

const base64UrlToBase64 = (value: string): string =>
  Buffer.from(base64UrlToBytes(value)).toString('base64');

const decodeClaimPayload = (payload: string): ProEntitlementClaim | null => {
  try {
    return JSON.parse(Buffer.from(base64UrlToBytes(payload)).toString('utf8')) as ProEntitlementClaim;
  } catch {
    return null;
  }
};

const validateClaimShape = (claims: ProEntitlementClaim): boolean =>
  claims.v === 1 &&
  claims.purpose === 'pro_entitlement_claim' &&
  claims.entitlement_tier === 'pro' &&
  typeof claims.account_id === 'string' &&
  claims.account_id.length > 0 &&
  typeof claims.server_fingerprint === 'string' &&
  claims.server_fingerprint.length > 0 &&
  // Optional, but not unchecked: absent means "no fresher answer than the
  // binding"; present-and-empty would be indistinguishable from "the handle was
  // removed", and the provisioner would act on it.
  (claims.publisher_handle === undefined
    || (typeof claims.publisher_handle === 'string' && claims.publisher_handle.length > 0)) &&
  typeof claims.iat === 'number' &&
  Number.isFinite(claims.iat) &&
  typeof claims.exp === 'number' &&
  Number.isFinite(claims.exp);

const verifyClaimEnvelope = (
  publicKeyB64: string,
  entitlementClaim: string,
  expected: StoredAccountBinding,
  now: number,
): VerifiedProEntitlementClaim | null => {
  const parts = entitlementClaim.split('.');
  if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== ENTITLEMENT_PREFIX) {
    return null;
  }
  const signingInput = `${ENTITLEMENT_PREFIX}.${parts[2]}`;
  if (!ed25519Verify(publicKeyB64, signingInput, base64UrlToBase64(parts[3]!))) {
    return null;
  }
  const claims = decodeClaimPayload(parts[2]!);
  if (!claims || !validateClaimShape(claims)) return null;
  if (claims.account_id !== expected.account_id) return null;
  if (claims.server_fingerprint !== expected.server_fingerprint) return null;
  if (claims.iat > now + CLAIM_FUTURE_SKEW_MS) return null;
  if (claims.exp <= now) return null;
  return {
    entitlement_claim: entitlementClaim,
    claims,
    expires_at: claims.exp,
  };
};

const isMintSuccess = (
  value: Record<string, unknown>,
): value is {
  ok: true;
  entitlement_claim: string;
  expires_at: number;
  entitlement_tier: 'pro';
  /** Optional, unvalidated here — `parseProHandleAnchor` owns the shape. Named
   *  on the narrowed type only so reading it is not a type error; the predicate
   *  deliberately does NOT require it, because a mint response without one is
   *  an ordinary success (no handle reserved, or a cloud older than this field). */
  handle_anchor?: unknown;
} =>
  value.ok === true &&
  typeof value.entitlement_claim === 'string' &&
  value.entitlement_claim.length > 0 &&
  typeof value.expires_at === 'number' &&
  value.entitlement_tier === 'pro';

export const createHttpProEntitlementSource = (
  deps: RealProEntitlementSourceDeps,
): ClaimBackedProEntitlementSource => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const fetchMintResponse = makeBoundedOriginHttpFetcher({
    fetchImpl,
    timeoutMs,
    ...(deps.maxResponseBytes !== undefined
      ? { maxResponseBytes: deps.maxResponseBytes }
      : {}),
  });

  const mint = async (
    endpoint: string,
    binding: StoredAccountBinding,
  ): Promise<
    // ⚠ THE STATUS IS CARRIED NOW, AND IT WAS DROPPED BEFORE. Without it a 400
    // (our own malformed request) and a 401 (the cloud rejecting a credential)
    // arrive as the same `credential_invalid`, and nothing downstream can tell a
    // local bug from a disconnection.
    { kind: 'response'; status: number; body: unknown } | { kind: 'unavailable' }
  > => {
    let response: Awaited<ReturnType<typeof fetchMintResponse>>;
    try {
      response = await fetchMintResponse(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          server_scoped_credential: binding.server_scoped_credential,
          server_fingerprint: binding.server_fingerprint,
        }),
      });
    } catch {
      return { kind: 'unavailable' };
    }
    try {
      return { kind: 'response', status: response.status, body: await response.json() };
    } catch {
      return { kind: 'response', status: response.status, body: undefined };
    }
  };

  const resolveClaim = async (): Promise<VerifiedProEntitlementClaim | null> => {
    let binding: StoredAccountBinding | null;
    try {
      binding = deps.loadBinding();
    } catch {
      return null;
    }
    if (!binding) return null;

    // No caching on the actuation path: every call re-mints so the Worker's
    // current-ownership recheck (DO `/owner`) runs each time. Serving a cached
    // claim would skip that recheck and let a claim minted before an
    // unbind/rebind keep authorising actuation until its TTL (D-175 P8b codex
    // finding — ownership revocation must take effect on the next resolve).
    const endpoint = deps.getEndpointUrl();
    const publicKeyB64 = deps.getPublicKeyB64();
    if (!endpoint || !publicKeyB64) return null;

    const minted = await mint(endpoint, binding);
    if (minted.kind === 'unavailable') return null;
    const body = minted.body;

    const obj =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>)
        : undefined;
    if (!obj || !isMintSuccess(obj)) {
      return null;
    }

    return verifyClaimEnvelope(publicKeyB64, obj.entitlement_claim, binding, now());
  };

  return {
    resolveClaim,
    async resolve(): Promise<ProEntitlementResolution> {
      let binding: StoredAccountBinding | null;
      try {
        binding = deps.loadBinding();
      } catch {
        return { state: 'unbound' };
      }
      if (!binding) return { state: 'unbound' };

      const endpoint = deps.getEndpointUrl();
      const publicKeyB64 = deps.getPublicKeyB64();
      if (!endpoint || !publicKeyB64) {
        return { state: 'unavailable', reason: 'entitlement_source_unconfigured' };
      }

      const minted = await mint(endpoint, binding);
      if (minted.kind === 'unavailable') {
        return { state: 'unavailable', reason: 'entitlement_mint_unavailable' };
      }
      const body = minted.body;

      const obj =
        body && typeof body === 'object'
          ? (body as Record<string, unknown>)
          : undefined;
      // Forward-compat: today's ownership-only mint never returns this code
      // (it mints for any bound owner); kept so a future entitlement-aware
      // mint that reports Free maps cleanly to `inactive-free` downstream.
      if (obj && obj.ok === false && obj.code === 'not_entitled') {
        return { state: 'not_entitled' };
      }
      // ⛔ THE CODE **AND** THE STATUS. `server_disowned` is only meaningful on
      // the 401 the owner-recheck raises; accepting it on any status would let a
      // proxy error page or a future 4xx reuse of the word stop a healthy
      // server. Two agreeing signals, because the consequence is terminal.
      if (obj && obj.ok === false && obj.code === 'server_disowned' && minted.status === 401) {
        return { state: 'disowned' };
      }
      if (!obj || !isMintSuccess(obj)) {
        return { state: 'unavailable', reason: 'entitlement_mint_invalid_response' };
      }
      const verified = verifyClaimEnvelope(
        publicKeyB64,
        obj.entitlement_claim,
        binding,
        now(),
      );
      if (!verified) {
        return { state: 'unavailable', reason: 'entitlement_claim_invalid' };
      }
      // The anchor is read off the RAW body, not the verified claim — it rides
      // outside the signature on purpose (see `ProHandleAnchor`). It is carried
      // only because the status surface needs it to explain itself; nothing
      // downstream may gate on it.
      const handle_anchor = parseProHandleAnchor(obj.handle_anchor);
      return {
        state: 'entitled',
        expires_at: verified.expires_at,
        ...(handle_anchor !== null ? { handle_anchor } : {}),
        // ⚠ FROM THE VERIFIED CLAIM, NOT THE RAW BODY — the opposite of the
        // anchor directly above, and deliberately so. The server MOVES A DNS
        // RECORD to this name; taking it from unsigned response JSON would let
        // anything that could shape a mint response re-point somebody's hostname.
        ...(verified.claims.publisher_handle !== undefined
          ? { publisher_handle: verified.claims.publisher_handle }
          : {}),
      };
    },
  };
};
