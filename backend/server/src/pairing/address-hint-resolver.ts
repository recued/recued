/** D-148 § A.6.5 — shared address-hint → `tls_domains` row resolver.
 *
 *  Two consumers — the pair-blob `PairBlobCertSource` adapter
 *  (`./sqlite-cert-source.ts`) AND the rotation-engine
 *  `TlsRenewalHook` adapter (`../keys/rotation/tls-renewal-hook.ts`) —
 *  share the same domain-selection rule: pick the row matching whichever
 *  address `selectServerUrl` (from `apps/webclient/src/auth/pair-input.ts`)
 *  would choose given the same hint snapshot, source-filter included.
 *
 *  The two consumers MUST agree on the picked row by construction. A
 *  drift would let the cert source seed pin-fingerprint X while the
 *  renewal hook renews cert Y → first-cert-pin compare on the renewed
 *  fingerprint fails as `cert_pin_mismatch`. Co-locating the resolution
 *  here keeps the alignment in one place.
 *
 *  Why not import `selectServerUrl` directly. Backend → apps imports are
 *  forbidden by package-boundary discipline; the resolver mirrors the
 *  webclient's 5-line LAN-first / DDNS-fallback rule verbatim. The
 *  sqlite-cert-source cluster's `selectServerUrl` cross-check test
 *  catches drift; that suite continues to apply post-extraction.
 *
 *  Spec: `docs/d-148-spec.md` § A.6.5. */

import type {
  TLSDomainCertListEntry,
  TLSDomainCertSource,
} from '@recued/contracts';

import type { SqliteTlsDomainStore } from '../tls/domain-store.js';

/** Address-hint snapshot shape — `{ lan: [...], ddns? }`. Read every
 *  call so consumers observe the live LAN bind state + the current
 *  DDNS posture without needing a re-bind on listener changes. */
export interface ServerAddressHintsSnapshot {
  lan: ReadonlyArray<string>;
  ddns?: string;
}

/** Mirror of `selectServerUrl` from
 *  `apps/webclient/src/auth/pair-input.ts:212`. Returns the first non-
 *  empty LAN URL, else the DDNS URL, else null. Verbatim duplicate;
 *  cross-check tests guard against drift. */
export const pickAddressMatchingClient = (
  hints: ServerAddressHintsSnapshot,
): string | null => {
  for (const candidate of hints.lan) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  if (typeof hints.ddns === 'string' && hints.ddns.length > 0) return hints.ddns;
  return null;
};

/** Extract the SNI hostname from the chosen address. Accepts both
 *  scheme-qualified URLs (`wss://alice.example:8443/ws`) AND the bare
 *  `host:port` form the spec uses for address hints
 *  (`alice.recued.cloud:8443` /
 *  `192.168.1.42:8443` / `[fe80::1]:8443`). The bare form does not
 *  parse as a URL on its own (`new URL('alice.recued.cloud:8443')`
 *  treats `alice.recued.cloud:` as a scheme + `8443` as the path, so
 *  `hostname` is empty), so we retry with a synthetic `wss://` prefix
 *  before giving up. Returns null only when neither parse yields a
 *  non-empty hostname.
 *
 *  IPv6 bracket-stripping. `URL.hostname` returns IPv6 addresses with
 *  the brackets intact (`[fe80::1]`), but cert SAN entries + the
 *  `tls_domains.domain` PK convention use the bare form (`fe80::1`).
 *  Strip exactly one matched pair of brackets so the store lookup
 *  finds the canonical row. */
export const extractHostname = (address: string): string | null => {
  let hostname: string | null = null;
  try {
    const parsed = new URL(address);
    if (typeof parsed.hostname === 'string' && parsed.hostname.length > 0) {
      hostname = parsed.hostname;
    }
  } catch {
    /* fall through to bare host:port form */
  }
  if (hostname === null) {
    try {
      const parsed = new URL(`wss://${address}`);
      if (typeof parsed.hostname === 'string' && parsed.hostname.length > 0) {
        hostname = parsed.hostname;
      }
    } catch {
      /* not parseable as either form */
    }
  }
  if (hostname === null) return null;
  if (
    hostname.length >= 2
    && hostname.startsWith('[')
    && hostname.endsWith(']')
  ) {
    return hostname.slice(1, -1);
  }
  return hostname;
};

/** Apply the `sha256:` prefix expected by the rotation engine's
 *  signed `cert_rotation_notice` fields when the stored value doesn't
 *  already carry it. Co-located so the cert source + the renewal hook
 *  emit identically-shaped fingerprints. */
export const withSha256Prefix = (hex: string): string =>
  hex.startsWith('sha256:') ? hex : `sha256:${hex}`;

export interface ResolveCanonicalDomainOptions {
  /** Synchronous hint reader. Same shape both consumers wire from
   *  `lanBindAddress` + `actualPort` + (future) DDNS host. */
  readHints: () => ServerAddressHintsSnapshot;
  /** Source of truth for per-domain rows. Only `list()` is used (sync,
   *  vault-lock-independent). */
  store: Pick<SqliteTlsDomainStore, 'list'>;
  /** Restrict which `TLSDomainCertSource` values to accept. Defaults to
   *  every source. The housekeeping consumer passes `['pro_acme']`
   *  because BYO certs rotate via user re-upload. */
  sources?: ReadonlyArray<TLSDomainCertSource>;
}

/** Resolve the canonical `tls_domains` row for whichever address the
 *  receiving client would actually connect to. Returns the matching
 *  row when it passes the source filter + has non-empty fingerprint +
 *  finite `expires_at`; null when nothing in the hint precedence chain
 *  resolves to a usable row.
 *
 *  Same call shape for both consumers: cert source projects fingerprint
 *  + valid_until; renewal hook hands the domain to the per-domain
 *  renewer. */
export const resolveCanonicalDomain = (
  options: ResolveCanonicalDomainOptions,
): TLSDomainCertListEntry | null => {
  const { readHints, store, sources } = options;
  const sourceFilter = sources ? new Set(sources) : null;
  const url = pickAddressMatchingClient(readHints());
  if (url === null) return null;
  const host = extractHostname(url);
  if (host === null) return null;
  const canonical = host.trim().toLowerCase();
  if (canonical.length === 0) return null;
  const rows = store.list();
  for (const row of rows) {
    if (row.domain !== canonical) continue;
    if (sourceFilter && !sourceFilter.has(row.source)) return null;
    if (typeof row.fingerprint !== 'string' || row.fingerprint.length === 0) {
      return null;
    }
    if (typeof row.expires_at !== 'number' || !Number.isFinite(row.expires_at)) {
      return null;
    }
    return row;
  }
  return null;
};
