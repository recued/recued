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

import type { ProEntitlementClaim } from '@recued/contracts';
import { ed25519Verify, type StoredAccountBinding } from '../keys/index.js';
import { makeBoundedOriginHttpFetcher } from '../bounded-origin-http-fetcher.js';

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
  | { state: 'entitled'; expires_at?: number }
  | { state: 'not_entitled' }
  | { state: 'unbound' }
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
const AUTH_WORKER_ORIGIN_PROD = 'https://auth.recued.com';
const AUTH_WORKER_ORIGIN_STAGING = 'https://auth.recued2.com';
export const PRO_ENTITLEMENT_MINT_PATH = '/v1/account/entitlement/mint';

const isRecued2CloudHost = (cloudBaseUrl: string | undefined): boolean => {
  if (!cloudBaseUrl) return false;
  try {
    return new URL(cloudBaseUrl).hostname.endsWith('.recued2.com');
  } catch {
    return false;
  }
};

export interface ResolveProEntitlementMintUrlOptions {
  override?: string;
  cloudBaseUrl?: string;
}

export const resolveProEntitlementMintUrl = (
  options: ResolveProEntitlementMintUrlOptions = {},
): string => {
  const override = options.override?.trim();
  if (override) return override;
  const origin = isRecued2CloudHost(options.cloudBaseUrl)
    ? AUTH_WORKER_ORIGIN_STAGING
    : AUTH_WORKER_ORIGIN_PROD;
  return `${origin}${PRO_ENTITLEMENT_MINT_PATH}`;
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
const PRO_ENTITLEMENT_PUBLIC_KEY_STAGING =
  'MCowBQYDK2VwAyEAhGQbD0X9QKJUaC0u1hkGcMYJxYKw9dYJOzCeU0sQ4j8=';

export interface ResolveProEntitlementPublicKeyOptions {
  /** `RECUED_PRO_ENTITLEMENT_PUBLIC_KEY_B64` — wins when set. Kept so a local
   *  rig / a private deployment can point at its own signer without a rebuild. */
  override?: string;
  /** The configured `cloud.base_url`; a `*.recued2.com` host selects staging. */
  cloudBaseUrl?: string;
}

export const resolveProEntitlementPublicKey = (
  options: ResolveProEntitlementPublicKeyOptions = {},
): string => {
  const override = options.override?.trim();
  if (override) return override;
  return isRecued2CloudHost(options.cloudBaseUrl)
    ? PRO_ENTITLEMENT_PUBLIC_KEY_STAGING
    : PRO_ENTITLEMENT_PUBLIC_KEY_PROD;
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
): value is { ok: true; entitlement_claim: string; expires_at: number; entitlement_tier: 'pro' } =>
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
  ): Promise<{ kind: 'response'; body: unknown } | { kind: 'unavailable' }> => {
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
      return { kind: 'response', body: await response.json() };
    } catch {
      return { kind: 'response', body: undefined };
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
      return { state: 'entitled', expires_at: verified.expires_at };
    },
  };
};
