/** D-176 Phase 2 — apply-agent wire protocol.
 *
 *  The cloud-side `RecuedAuthoritativeProvider` (backend/api) talks to the
 *  VPS apply-agent (backend/dns-agent) over a cloudflared tunnel. The tunnel
 *  hostname is publicly reachable through the Cloudflare edge, so every
 *  request carries app-level auth: an HMAC-SHA-256 signature over
 *  `POST\n${path}\n${timestamp}\n${rawBody}` with a shared secret. Binding
 *  the path makes a captured signature single-OPERATION (an apply can never
 *  be replayed as a remove); the clock-skew window bounds its lifetime; and
 *  the agent's post-verification replay cache (one entry per accepted
 *  signature) makes it single-USE within that window. The periodic drift
 *  reconcile heals anything beyond that.
 *
 *  All operations are POST with a JSON body (one signing rule — no query-
 *  string canonicalization), including the zone-state read. `GET /health` is
 *  the only unauthenticated route (liveness, no secrets).
 *
 *  Both ends import THIS module — paths, headers, shapes, and the sign /
 *  verify pair — so the protocol cannot drift between the Worker (WebCrypto
 *  global) and the Node agent (Node ≥18 exposes the same `crypto.subtle`).
 */

import type { DnsAddressRecord, DnsAddressType } from './ddns-provider.js';

/** Route table. The agent serves exactly these; the provider calls them. */
export const DNS_APPLY_PATHS = {
  /** Create/replace one A or AAAA RRset → `DnsApplyOkResponse`. */
  rrsetApply: '/v1/dns/rrset/apply',
  /** Remove RRset(s) for a hostname → `DnsApplyOkResponse`. */
  rrsetRemove: '/v1/dns/rrset/remove',
  /** List published A/AAAA under a suffix → `DnsZoneStateResponse`. */
  zoneState: '/v1/dns/zone/state',
  /** Disaster recovery: converge the zone's A/AAAA set to a full snapshot
   *  (rebuild-from-D1 drill) → `DnsZoneRebuildResponse`. */
  zoneRebuild: '/v1/dns/zone/rebuild',
  /** D-176 Phase 8 — publish one ACME DNS-01 challenge TXT (read-merged
   *  into any existing `_acme-challenge.<domain>` rrset) → `DnsApplyOkResponse`. */
  acmePresent: '/v1/dns/acme/present',
  /** D-176 Phase 8 — remove one ACME DNS-01 challenge TXT value (DELETEs the
   *  rrset when it leaves no values) → `DnsApplyOkResponse`. */
  acmeCleanup: '/v1/dns/acme/cleanup',
} as const;

/** Unauthenticated liveness route (GET). */
export const DNS_APPLY_HEALTH_PATH = '/health';

/** Epoch-ms timestamp the signature covers, as a decimal string. */
export const DNS_APPLY_TIMESTAMP_HEADER = 'x-recued-dns-timestamp';
/** Lowercase-hex HMAC-SHA-256 over `${timestamp}.${rawBody}`. */
export const DNS_APPLY_SIGNATURE_HEADER = 'x-recued-dns-signature';

/** Replay bound: the agent rejects a timestamp further than this from its
 *  clock (either direction — tolerates modest skew between Worker and VPS). */
export const DNS_APPLY_MAX_SKEW_MS = 5 * 60 * 1000;

/** `rrsetApply` body — one address RRset to create/replace. Identical shape
 *  to the seam's `DnsAddressRecord` (re-exported for call-site clarity). */
export type DnsApplyRRsetRequest = DnsAddressRecord;

/** `rrsetRemove` body. Omitting `type` removes both A and AAAA — the
 *  lifecycle park/remove path. */
export interface DnsApplyRemoveRequest {
  hostname: string;
  type?: DnsAddressType;
}

/** `zoneState` body — list A/AAAA at or under `suffix`. */
export interface DnsZoneStateRequest {
  suffix: string;
}

export interface DnsZoneStateResponse {
  records: DnsAddressRecord[];
}

/** `zoneRebuild` body — the FULL desired A/AAAA set under `suffix`,
 *  derived from the canonical D1 store. The agent converges the zone to
 *  exactly this set: every listed record is REPLACEd, every published
 *  A/AAAA under `suffix` not listed is DELETEd. Non-address types (SOA /
 *  NS / TXT) are never touched. */
export interface DnsZoneRebuildRequest {
  suffix: string;
  records: DnsAddressRecord[];
}

export interface DnsZoneRebuildResponse {
  ok: true;
  /** RRsets written (REPLACE). */
  applied: number;
  /** RRsets deleted as no-longer-desired. */
  removed: number;
}

/** `acmePresent` / `acmeCleanup` body — one ACME DNS-01 challenge TXT.
 *
 *  `fqdn` is the FULL challenge name the CA validates (`_acme-challenge.<domain>`,
 *  the same string the LE provider already constructs), not the bare handle —
 *  the agent scopes these endpoints to `_acme-challenge.*` and never touches the
 *  converge-managed A/AAAA surface, so an in-flight rebuild can't prune a
 *  challenge and a challenge can't pollute the address state read.
 *
 *  `value` is the base64url DNS-01 key authorization digest; the agent quotes it
 *  for PowerDNS. A SAN cert for `<h>` + `*.<h>` validates two authorizations
 *  against the SAME `_acme-challenge.<h>` name — so `present` read-MERGES into the
 *  existing rrset (never blind-replace) and `cleanup` removes only its own value
 *  (`ttl` is carried for protocol uniformity but unused on cleanup). */
export interface DnsAcmeChallengeRequest {
  fqdn: string;
  value: string;
  ttl: number;
}

export interface DnsApplyOkResponse {
  ok: true;
}

/** Non-2xx envelope. `error` is a stable snake_case code. */
export interface DnsApplyErrorResponse {
  error: string;
  message?: string;
}

/** Signature verification outcome — distinct codes so the agent's 401 can
 *  say WHY without leaking which byte mismatched. */
export type DnsApplyVerifyResult =
  | 'ok'
  /** Timestamp missing/unparseable or outside `DNS_APPLY_MAX_SKEW_MS`. */
  | 'stale_timestamp'
  /** Signature missing, malformed hex, or HMAC mismatch. */
  | 'bad_signature';

const encoder = new TextEncoder();

const importHmacKey = (
  secret: string,
  usage: 'sign' | 'verify',
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );

/** The signed material commits to the OPERATION (method + path), the
 *  moment, and the exact body bytes — newline-delimited so no field can
 *  bleed into the next (paths contain no newlines by construction). */
const signedBytes = (
  path: string,
  timestampMs: number,
  rawBody: string,
): Uint8Array => encoder.encode(`POST\n${path}\n${timestampMs}\n${rawBody}`);

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Strict lowercase/uppercase-hex decode; null on any malformed input. */
const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/** Provider side: hex HMAC-SHA-256 over the request's signed material.
 *  `path` is the `DNS_APPLY_PATHS` value being POSTed. Send `timestampMs`
 *  in `DNS_APPLY_TIMESTAMP_HEADER` and this in `DNS_APPLY_SIGNATURE_HEADER`. */
export const signDnsApplyRequest = async (
  secret: string,
  path: string,
  timestampMs: number,
  rawBody: string,
): Promise<string> => {
  const key = await importHmacKey(secret, 'sign');
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    signedBytes(path, timestampMs, rawBody) as unknown as Parameters<
      typeof crypto.subtle.sign
    >[2],
  );
  return bytesToHex(new Uint8Array(mac));
};

/** Agent side: skew-check the timestamp, then verify the signature with
 *  `crypto.subtle.verify` (constant-time). `path` is the REQUEST path being
 *  dispatched (query string stripped); `timestampHeader` / `signatureHeader`
 *  are the raw header values (null when absent). */
export const verifyDnsApplyRequest = async (input: {
  secret: string;
  path: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  rawBody: string;
  nowMs: number;
}): Promise<DnsApplyVerifyResult> => {
  const { secret, path, timestampHeader, signatureHeader, rawBody, nowMs } =
    input;
  if (!timestampHeader || !/^\d{1,15}$/.test(timestampHeader)) {
    return 'stale_timestamp';
  }
  const timestampMs = Number(timestampHeader);
  if (Math.abs(nowMs - timestampMs) > DNS_APPLY_MAX_SKEW_MS) {
    return 'stale_timestamp';
  }
  if (!signatureHeader) return 'bad_signature';
  const sigBytes = hexToBytes(signatureHeader);
  if (!sigBytes || sigBytes.length !== 32) return 'bad_signature';
  const key = await importHmacKey(secret, 'verify');
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes as unknown as Parameters<typeof crypto.subtle.verify>[2],
    signedBytes(path, timestampMs, rawBody) as unknown as Parameters<
      typeof crypto.subtle.verify
    >[3],
  );
  return valid ? 'ok' : 'bad_signature';
};
