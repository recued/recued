/** D-148 § A.6.3 (W3.6) — node:crypto-backed verifier seam for the
 *  W3.2 `TLSDomainUploadVerifiers` contract + the W3.6 production
 *  metadata reader.
 *
 *  The W3.2 substrate defined the seam shape but couldn't import
 *  `node:crypto` (contracts is bundle-portable; runs on webclient +
 *  bridge + server). W3.6 wires the production-side wrappers via
 *  `X509Certificate` + `createPrivateKey` + `crypto.verify` so the
 *  same validators that pure-tested in W3.2 now run against real
 *  certs at upload time.
 *
 *  Verifier coverage (each maps 1:1 to a `TLSDomainUploadIssue`):
 *
 *    - `extractSANs(cert_pem)`            → DNS SAN entries
 *    - `verifyKeyPair(cert_pem, key_pem)` → `checkPrivateKey` round-trip
 *    - `verifyChain(cert, chain, opts)`   → `X509Certificate.verify`
 *      against caller-supplied chain; `accept_self_signed` opts
 *      through (BYO niche)
 *    - `readExpiresAt(cert_pem)`          → `validToDate.getTime()`
 *
 *  Plus the W3.6 metadata reader (NOT on the W3.2 contract):
 *
 *    - `extractIssuer(cert_pem)` — issuer common-name (falls back to
 *      the full DN when CN missing) for the `TLSDomainCertListEntry`
 *      `issuer` slot. */

import { createPrivateKey, X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import type { TLSDomainUploadVerifiers } from '@recued/contracts';
import type { TlsDomainCertReader } from './domain-store.js';

const tryParseCert = (cert_pem: string): X509Certificate | null => {
  try {
    return new X509Certificate(cert_pem);
  } catch {
    return null;
  }
};

/** Parse the SAN block + extract DNS entries. Returns lowercase
 *  punycode strings (DNS names are case-insensitive). Empty array on
 *  parse failure / no SAN extension — `matchesSANForDomain` reports
 *  mismatch which surfaces as a closed-list `tls_san_mismatch`
 *  validation issue. */
export const extractSANs = (cert_pem: string): string[] => {
  const cert = tryParseCert(cert_pem);
  if (!cert) return [];
  const raw = cert.subjectAltName;
  if (!raw || typeof raw !== 'string') return [];
  // `subjectAltName` formats like `"DNS:example.com, DNS:*.example.com,
  // IP Address:1.2.3.4, email:foo@bar"`. We only want the `DNS:`
  // entries — IP-address SANs are out of scope for the multi-domain
  // hostname feature (Mary uploads certs covering domains, not IPs).
  const entries: string[] = [];
  for (const segment of raw.split(',')) {
    const trimmed = segment.trim();
    if (trimmed.startsWith('DNS:')) {
      entries.push(trimmed.slice('DNS:'.length).trim().toLowerCase());
    }
  }
  return entries;
};

/** Verify the private key forms a valid pair with the cert. Uses
 *  `X509Certificate.checkPrivateKey()` which is the canonical Node
 *  API for this gate (handles RSA + ECDSA + Ed25519 + Ed448 in one
 *  call). Any parse / load / mismatch failure returns false rather
 *  than throws — the validator turns the false into a closed-list
 *  `tls_key_pair_mismatch` issue. */
export const verifyKeyPair = (cert_pem: string, private_key_pem: string): boolean => {
  const cert = tryParseCert(cert_pem);
  if (!cert) return false;
  try {
    const key = createPrivateKey(private_key_pem);
    return cert.checkPrivateKey(key);
  } catch {
    return false;
  }
};

/** Verify the chain terminates at a public CA root. Walks the leaf →
 *  intermediates → root (system trust store) chain via Node's
 *  `X509Certificate.verify(issuer.publicKey)`. When `chain_pem` is
 *  empty AND the leaf is self-signed, returns
 *  `opts.accept_self_signed`.
 *
 *  Approach: the spec-aligned "terminates at a public CA" is normally
 *  enforced by a TLS handshake against a real connection. For an
 *  upload gate we do a pragmatic walk:
 *
 *    1. Parse the chain into an array of `X509Certificate`s.
 *    2. Confirm each cert's `verify(next.publicKey)` succeeds — this
 *       proves cryptographic continuity.
 *    3. Check the chain's terminal cert's issuer matches a system-
 *       trusted root (we delegate via `X509Certificate.checkIssued`
 *       on the root vs system trust). When the chain doesn't reach
 *       a trusted root AND the leaf isn't self-signed, return false.
 *
 *  The `accept_self_signed` opt-in lets a niche dev / on-prem flow
 *  upload a self-signed cert with explicit acknowledgement. Default
 *  false. */
export const verifyChain = (
  cert_pem: string,
  chain_pem: string | undefined,
  opts: { accept_self_signed: boolean },
): boolean => {
  const leaf = tryParseCert(cert_pem);
  if (!leaf) return false;
  // Self-signed detection — leaf's issuer matches its subject + the
  // cert verifies against its own public key.
  const isSelfSigned = leaf.issuer === leaf.subject && leaf.verify(leaf.publicKey);
  if (isSelfSigned) {
    return opts.accept_self_signed;
  }
  // Parse the supplied chain into ordered intermediates. Empty chain
  // means the caller relies on the system trust store catching the
  // leaf's direct issuer; when no chain AND not self-signed, we cannot
  // verify cryptographic continuity at upload time → reject. The
  // caller can supply the issuer chain from the same source that
  // issued the cert (ACME flows always return the issuer chain).
  const chain = parseChainPem(chain_pem);
  if (chain.length === 0) {
    // Per § A.6.3: "Chain must terminate at a public CA root (self-
    // signed accepted with explicit Mary acknowledgement; niche)" —
    // missing chain on a non-self-signed cert is a `tls_chain_invalid`
    // gate failure.
    return false;
  }
  // Walk leaf → chain[0] → chain[1] → … verifying each step's
  // signature against the next cert's public key. Last entry must
  // chain to a system-trusted root (per § A.6.3 "Chain must terminate
  // at a public CA root").
  let current = leaf;
  for (const next of chain) {
    if (!current.verify(next.publicKey)) {
      return false;
    }
    current = next;
  }
  // Codex W3.6 P1 #2 fold — the terminal cert MUST chain to the
  // system trust store. Previously this returned true for any
  // cryptographically-continuous chain regardless of whether the
  // terminal cert was trusted, which let an attacker upload a leaf
  // signed by their own private CA + bundle that CA as the chain.
  //
  // Two acceptable terminal states:
  //   - The terminal cert IS one of the system roots (its
  //     SHA-256 fingerprint matches a root in `tls.rootCertificates`).
  //   - The terminal cert is signed BY a system root (typical for
  //     ACME chains that end at the issuing CA's intermediate,
  //     leaving the next hop's root in the OS trust store).
  return terminalChainsToTrustRoot(current);
};

let cachedTrustRoots: X509Certificate[] | null = null;
const getSystemTrustRoots = (): X509Certificate[] => {
  if (cachedTrustRoots) return cachedTrustRoots;
  const roots: X509Certificate[] = [];
  for (const pem of rootCertificates) {
    try {
      roots.push(new X509Certificate(pem));
    } catch {
      // Skip unparseable system root (would be a Node-internal bug).
    }
  }
  cachedTrustRoots = roots;
  return roots;
};

const terminalChainsToTrustRoot = (terminal: X509Certificate): boolean => {
  const roots = getSystemTrustRoots();
  const terminalFp = terminal.fingerprint256;
  for (const root of roots) {
    if (root.fingerprint256 === terminalFp) {
      // Terminal IS a system root.
      return true;
    }
  }
  for (const root of roots) {
    try {
      if (terminal.verify(root.publicKey)) {
        // Terminal is signed by a system root (the typical ACME chain
        // shape — chain ends at the issuing intermediate; the root
        // lives in the OS trust store).
        return true;
      }
    } catch {
      // Skip a root we cannot verify against (algorithm mismatch /
      // unsupported key shape). Other roots may still match.
    }
  }
  return false;
};

const parseChainPem = (chain_pem: string | undefined): X509Certificate[] => {
  if (!chain_pem) return [];
  const begin = '-----BEGIN CERTIFICATE-----';
  const end = '-----END CERTIFICATE-----';
  const certs: X509Certificate[] = [];
  let cursor = 0;
  while (cursor < chain_pem.length) {
    const start = chain_pem.indexOf(begin, cursor);
    if (start === -1) break;
    const stop = chain_pem.indexOf(end, start + begin.length);
    if (stop === -1) break;
    const block = chain_pem.slice(start, stop + end.length);
    const cert = tryParseCert(block);
    if (!cert) break;
    certs.push(cert);
    cursor = stop + end.length;
  }
  return certs;
};

/** Read the cert's notAfter as unix-ms. Returns 0 when the cert
 *  cannot be parsed — the validator turns the 0 into a closed-list
 *  `tls_cert_expired_at_upload` issue (since 0 is in the past relative
 *  to any plausible `now_ms`).
 *
 *  Reads `cert.validTo` (string, available since Node v15.6.0) and
 *  parses via `Date.parse`. The validTo format is the OpenSSL-style ASN.1
 *  GeneralizedTime rendering (e.g., `Mar 12 12:00:00 2027 GMT`) which
 *  `Date.parse` handles.
 *
 *  ⚠ THE ORIGINAL REASON FOR THE STRING NO LONGER HOLDS, AND THE CHOICE
 *  STANDS ANYWAY. This said `cert.validToDate` "was only added in Node
 *  v23.0.0 — `backend/server` engines floor is Node ≥ 20.0.0 (Codex W3.6
 *  P1 #1 fold) so we MUST use the portable string." The floor is now
 *  ≥ 24.0.0, so `validToDate` is available and nothing forces this. It is
 *  kept because a working parse of a stable OpenSSL rendering is not worth
 *  re-verifying against a live CA chain to save one `Date.parse`, not
 *  because it is required — so a later reader weighing the swap is weighing
 *  ergonomics, not compatibility. */
export const readExpiresAt = (cert_pem: string): number => {
  const cert = tryParseCert(cert_pem);
  if (!cert) return 0;
  const raw = cert.validTo;
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
};

/** Read the cert's issuer common-name. Falls back to the full issuer
 *  DN when CN absent. Returns an empty string when the cert cannot be
 *  parsed — the store records the empty string so `list()` rows
 *  remain queryable. */
export const extractIssuer = (cert_pem: string): string => {
  const cert = tryParseCert(cert_pem);
  if (!cert) return '';
  const dn = cert.issuer;
  if (typeof dn !== 'string' || dn.length === 0) return '';
  // X509Certificate.issuer formats as `\n`-joined `Key=Value` rows in
  // recent Node (≥ v17). Older shapes return a single-line OpenSSL-
  // formatted DN (`/CN=...`). Handle both.
  const lines = dn.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('CN=')) return trimmed.slice('CN='.length);
  }
  // Single-line OpenSSL form like `/C=US/O=Foo/CN=Bar`.
  const cnIdx = dn.indexOf('CN=');
  if (cnIdx >= 0) {
    const rest = dn.slice(cnIdx + 'CN='.length);
    const slash = rest.indexOf('/');
    return slash >= 0 ? rest.slice(0, slash) : rest;
  }
  return dn;
};

/** Build the production verifier seam. Same shape as
 *  `TLSDomainUploadVerifiers` from contracts; suitable for direct
 *  hand-off to `validateTLSDomainUpload` + the SQLite
 *  `createSqliteTlsDomainStore({ verifiers })` slot. */
export const createNodeTlsVerifiers = (): TLSDomainUploadVerifiers => ({
  extractSANs,
  verifyKeyPair,
  verifyChain,
  readExpiresAt,
});

/** Build the production metadata reader. Same shape as
 *  `TlsDomainCertReader` from `./domain-store.ts`; suitable for the
 *  `metadataReader` slot. */
export const createNodeTlsMetadataReader = (): TlsDomainCertReader => ({
  extractIssuer,
});
