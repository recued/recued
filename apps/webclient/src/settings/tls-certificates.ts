/** D-148 § A.6.3 — Settings → Server → TLS Certificates page renderer (W3.8).
 *
 *  The public listener (port 443) supports multi-domain SNI: each
 *  domain hosted on the server has its own cert + private key. The
 *  Settings page lists every configured domain + lets Mary upload a
 *  new BYO cert / replace an existing one / remove a stale one. Pro
 *  recued.cloud domains auto-renew via the existing ACME helper;
 *  BYO-uploaded domains are user-managed.
 *
 *  This module is the renderer + dispatch builders. The substrate
 *  (W3.2 `TLSDomainStore` + `validateTLSDomainUpload`) is the source
 *  of truth; the renderer projects `TLSDomainCertListEntry[]` into a
 *  UI-ready row model + computes severity (overdue / expiring / healthy)
 *  + threads the validator's issue list into per-issue user copy.
 *
 *  Per § A.6.3 + W3.6, BYO certs do not auto-renew at v1 — would
 *  require per-domain DNS-provider integration, deferred. The UI
 *  surfaces a per-row "manual renewal" hint accordingly.
 */

import {
  TLS_CERT_MIN_VALIDITY_MS,
  type TLSDomainCertListEntry,
  type TLSDomainCertSource,
  type TLSDomainUploadInput,
  type TLSDomainUploadIssue,
  type TLSDomainUploadValidation,
} from '@recued/contracts';

/** Per-row severity. Drives the badge color + sort order. */
export type TLSCertRowSeverity =
  | 'expired'
  | 'expiring_critical'
  | 'expiring_soon'
  | 'healthy';

/** UI row shape. One row per configured domain. */
export interface TLSCertRow {
  domain: string;
  fingerprint_short: string;
  fingerprint_full: string;
  expires_at: number;
  days_until_expiry: number;
  issuer: string;
  source: TLSDomainCertSource;
  /** Translated source label for the UI badge. */
  source_label: string;
  /** True iff the source is `pro_acme` — Pro tier auto-renews via
   *  the ACME helper. */
  auto_renew: boolean;
  /** Last successful renewal (Pro tier); absent for BYO uploads. */
  last_renewed_at?: number;
  severity: TLSCertRowSeverity;
  /** True iff the renewal is overdue (cert expired OR within 7 days
   *  of expiry on a BYO source). Drives the "Renew now" affordance. */
  renewal_due: boolean;
  /** True iff a manual renewal hint should surface (BYO + expiring
   *  inside the warning window). */
  manual_renewal_hint: boolean;
}

/** Per-source user-facing label. */
export const TLS_CERT_SOURCE_LABEL: Record<TLSDomainCertSource, string> = {
  pro_acme: 'Pro auto-managed (ACME)',
  byo_upload: 'BYO (user-uploaded)',
};

/** Closed-list issue → user-facing copy. Used by the upload form to
 *  surface validator issues inline. */
export const TLS_UPLOAD_ISSUE_COPY: Record<TLSDomainUploadIssue['code'], string> = {
  tls_san_mismatch:
    'The uploaded cert\'s SAN list does not cover this domain. Verify the cert matches before re-uploading.',
  tls_key_pair_mismatch:
    'The private key does not match the cert. Re-export the matching pair + retry.',
  tls_chain_invalid:
    'The cert chain does not terminate at a public CA root. Include the issuer chain in the upload.',
  tls_cert_expired_at_upload:
    'The cert has already expired. Renew with the issuer + upload the new cert.',
};

const SEVERITY_ORDER: Record<TLSCertRowSeverity, number> = {
  expired: 0,
  expiring_critical: 1,
  expiring_soon: 2,
  healthy: 3,
};

const EXPIRING_CRITICAL_WINDOW_MS = 7 * 86_400_000;
const EXPIRING_SOON_WINDOW_MS = 30 * 86_400_000;
const DAY_MS = 86_400_000;

const shortFingerprint = (full: string): string => {
  if (full.length <= 12) return full;
  return `${full.slice(0, 8)}…${full.slice(-4)}`;
};

const computeSeverity = (
  expires_at: number,
  now_ms: number,
): TLSCertRowSeverity => {
  const delta = expires_at - now_ms;
  if (delta <= 0) return 'expired';
  if (delta < EXPIRING_CRITICAL_WINDOW_MS) return 'expiring_critical';
  if (delta < EXPIRING_SOON_WINDOW_MS) return 'expiring_soon';
  return 'healthy';
};

/** Project a single store row into the UI row. Pure projection — no
 *  IO. Caller refreshes after `tls_domain.changed` broadcast events
 *  (W3.x follow-up) or per page-mount refetch. */
export const buildTLSCertRow = (
  entry: TLSDomainCertListEntry,
  args: { now_ms: number },
): TLSCertRow => {
  const severity = computeSeverity(entry.expires_at, args.now_ms);
  const days_until_expiry = Math.floor((entry.expires_at - args.now_ms) / DAY_MS);
  const auto_renew = entry.source === 'pro_acme';
  const renewal_due =
    severity === 'expired'
    || (severity === 'expiring_critical' && entry.source === 'byo_upload');
  const manual_renewal_hint =
    entry.source === 'byo_upload'
    && (severity === 'expiring_critical' || severity === 'expiring_soon');
  return {
    domain: entry.domain,
    fingerprint_short: shortFingerprint(entry.fingerprint),
    fingerprint_full: entry.fingerprint,
    expires_at: entry.expires_at,
    days_until_expiry,
    issuer: entry.issuer,
    source: entry.source,
    source_label: TLS_CERT_SOURCE_LABEL[entry.source],
    auto_renew,
    ...(entry.last_renewed_at !== undefined ? { last_renewed_at: entry.last_renewed_at } : {}),
    severity,
    renewal_due,
    manual_renewal_hint,
  };
};

/** Full page model. Rows ordered by severity then by domain name so
 *  the most urgent renewals surface first. */
export interface TLSCertificatesPageModel {
  rows: ReadonlyArray<TLSCertRow>;
  severity_summary: {
    expired_count: number;
    expiring_critical_count: number;
    expiring_soon_count: number;
    healthy_count: number;
    badge: 'healthy' | 'attention' | 'critical';
  };
  /** True iff at least one Pro-managed domain is configured — drives
   *  the "Auto-renewal active" banner. */
  has_pro_managed: boolean;
  /** True iff at least one BYO-uploaded domain is configured — drives
   *  the BYO section's visibility. */
  has_byo_uploaded: boolean;
}

const computeBadge = (
  expired: number,
  critical: number,
  soon: number,
): 'healthy' | 'attention' | 'critical' => {
  if (expired > 0 || critical > 0) return 'critical';
  if (soon > 0) return 'attention';
  return 'healthy';
};

/** Build the rendered page model from `TLSDomainStore.list()` output. */
export const buildTLSCertificatesPageModel = (args: {
  entries: ReadonlyArray<TLSDomainCertListEntry>;
  now_ms: number;
}): TLSCertificatesPageModel => {
  const rows = args.entries.map((entry) => buildTLSCertRow(entry, { now_ms: args.now_ms }));
  rows.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity];
    const sb = SEVERITY_ORDER[b.severity];
    if (sa !== sb) return sa - sb;
    return a.domain.localeCompare(b.domain);
  });
  const expired_count = rows.filter((r) => r.severity === 'expired').length;
  const expiring_critical_count = rows.filter(
    (r) => r.severity === 'expiring_critical',
  ).length;
  const expiring_soon_count = rows.filter((r) => r.severity === 'expiring_soon').length;
  const healthy_count = rows.filter((r) => r.severity === 'healthy').length;
  return {
    rows,
    severity_summary: {
      expired_count,
      expiring_critical_count,
      expiring_soon_count,
      healthy_count,
      badge: computeBadge(expired_count, expiring_critical_count, expiring_soon_count),
    },
    has_pro_managed: rows.some((r) => r.source === 'pro_acme'),
    has_byo_uploaded: rows.some((r) => r.source === 'byo_upload'),
  };
};

// ────────────────────────────────────────────────────────────────
// Dispatch builders
// ────────────────────────────────────────────────────────────────

/** Payload for `tls_domain.upload`. Threaded by the page-shell into
 *  the rpc conn. */
export interface TLSDomainUploadDispatch {
  op: 'tls_domain.upload';
  domain: string;
  cert_pem: string;
  private_key_pem: string;
  chain_pem?: string;
  source: TLSDomainCertSource;
}

/** Payload for `tls_domain.remove`. */
export interface TLSDomainRemoveDispatch {
  op: 'tls_domain.remove';
  domain: string;
}

export const buildTLSDomainUploadDispatch = (
  input: TLSDomainUploadInput,
): TLSDomainUploadDispatch => ({
  op: 'tls_domain.upload',
  domain: input.domain,
  cert_pem: input.cert_pem,
  private_key_pem: input.private_key_pem,
  ...(input.chain_pem !== undefined ? { chain_pem: input.chain_pem } : {}),
  source: input.source,
});

export const buildTLSDomainRemoveDispatch = (domain: string): TLSDomainRemoveDispatch => ({
  op: 'tls_domain.remove',
  domain,
});

/** Project the validator's discriminated result into a render-ready
 *  form. Surfaces the closed-list issue copy + the projected
 *  `expires_at` + the in-warning-window `warns` block. Used by the
 *  upload form to render pre-submit feedback. */
export interface TLSDomainUploadFormState {
  ok: boolean;
  /** Per-issue copy keyed by issue code. The UI surfaces one inline
   *  hint per issue. */
  issues: ReadonlyArray<{ code: TLSDomainUploadIssue['code']; copy: string }>;
  /** Projected expiry (post-validation) — surfaces only on the ok
   *  branch. */
  expires_at?: number;
  /** SANs extracted from the cert — surfaces on the ok branch as the
   *  "this cert covers" line. */
  san?: ReadonlyArray<string>;
  /** True iff the cert is valid but expires within the 7-day warning
   *  window — surfaces a "expires soon" inline hint. */
  expiry_within_7d?: boolean;
}

export const projectUploadValidation = (
  validation: TLSDomainUploadValidation,
): TLSDomainUploadFormState => {
  if (!validation.ok) {
    return {
      ok: false,
      issues: validation.issues.map((issue) => ({
        code: issue.code,
        copy: TLS_UPLOAD_ISSUE_COPY[issue.code],
      })),
    };
  }
  return {
    ok: true,
    issues: [],
    expires_at: validation.expires_at,
    san: validation.san,
    ...(validation.warns.expiry_within_7d ? { expiry_within_7d: true } : {}),
  };
};

export { TLS_CERT_MIN_VALIDITY_MS };
