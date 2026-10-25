/** D-148 § A.6.3 — Settings → Server → Certificates page renderer (W3.8).
 *
 *  ⚠ THE TAB IS "Certificates", NOT "TLS Certificates" — this header said the
 *  latter until 2026-09-16, which is a name a reader scanning the Server tabs
 *  does not find.
 *
 *  The public listener (port 443) supports multi-domain SNI: each
 *  domain hosted on the server has its own cert + private key. The
 *  Settings page lists every configured domain + lets Mary upload a
 *  new BYO cert / replace an existing one / remove a stale one. Pro
 *  recued.net domains auto-renew via the existing ACME helper;
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
  isFleetIssuedTlsDomainSource,
  type TLSDomainCertListEntry,
  type TLSDomainCertSource,
  type TLSDomainUploadInput,
  type TLSDomainUploadIssue,
  type TLSDomainUploadResult,
  type TLSDomainUploadValidation,
} from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { CERTIFICATES_WORKSPACE_STYLES } from './certificates-workspace-styles.js';

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
  pro_acme: 'Pro auto-managed (your Pro web address)',
  // D-235 — same management, different zone. The label says "my domain" because
  // that is the distinction a user cares about; the one that matters
  // operationally (renewal depends on a CNAME in a zone Recued does not
  // control) surfaces on the row itself, not in a badge.
  pro_acme_custom: 'Pro auto-managed (my domain)',
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
  // D-235 — asks the SOURCE, not one member of it. `=== 'pro_acme'` would
  // render a fleet-issued custom cert as not-auto-renewed, which is the badge
  // that tells a user to go renew it by hand.
  const auto_renew = isFleetIssuedTlsDomainSource(entry.source);
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
    has_pro_managed: rows.some((r) => isFleetIssuedTlsDomainSource(r.source)),
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

// ════════════════════════════════════════════════════════════════
// Panel — the surface that finally CALLS the builders above
// ════════════════════════════════════════════════════════════════
//
// ⛔ The builders, the issue copy and the page model shipped in W3.8 and sat
//    with ZERO production callers: the module exported no mount, nothing in
//    `bootstrap-settings-route.ts` rendered it, and `buildTLSDomainUploadDispatch`
//    appeared only in the barrel re-export and its own unit test. Everything was
//    typed and green, and a user who picked "Upload my own certificate" in the
//    Hostnames panel had nowhere to put the certificate — the row could never be
//    verified (`cert_proof` asserts a live handshake serves a matching cert) and
//    the SNI dispatcher failed the handshake `tls_domain_unknown` forever.
//
// 🔑 SOURCE IS PINNED TO `byo_upload` AND IS NOT A FIELD. The other two members
//    of `TLSDomainCertSource` mean "the fleet issued this and the fleet renews
//    it". Letting a hand-uploaded cert claim one of them would hand it to the
//    renewal machinery, which cannot renew a cert it never issued — the failure
//    surfaces ~90 days later as a browser error, which is precisely the shape
//    `isFleetIssuedTlsDomainSource` exists to prevent.

/** Stable DOM hooks. */
export const TLS_CERTS_PANEL_ATTR = 'data-recued-tls-certs-panel';
export const TLS_CERTS_STATUS_ATTR = 'data-recued-tls-certs-status';
export const TLS_CERTS_READ_RETRY_ATTR = 'data-recued-tls-certs-read-retry';
export const TLS_CERTS_READ_HEADING_ATTR = 'data-recued-tls-certs-read-heading';
export const TLS_CERTS_REMOVAL_RESULT_ATTR = 'data-recued-tls-certs-removal-result';
export const TLS_CERTS_STALE_ATTR = 'data-recued-tls-certs-stale';
export const TLS_CERTS_ERROR_ATTR = 'data-recued-tls-certs-error';
export const TLS_CERTS_EMPTY_ATTR = 'data-recued-tls-certs-empty';
export const TLS_CERTS_ROW_ATTR = 'data-recued-tls-certs-row';
export const TLS_CERTS_ROW_SEVERITY_ATTR = 'data-recued-tls-certs-row-severity';
export const TLS_CERTS_UPLOAD_OPEN_BTN_ATTR = 'data-recued-tls-certs-upload-open';
export const TLS_CERTS_UPLOAD_FORM_ATTR = 'data-recued-tls-certs-upload-form';
export const TLS_CERTS_UPLOAD_FIELD_ATTR = 'data-recued-tls-certs-upload-field';
export const TLS_CERTS_UPLOAD_FILE_ATTR = 'data-recued-tls-certs-upload-file';
export const TLS_CERTS_UPLOAD_SUBMIT_BTN_ATTR = 'data-recued-tls-certs-upload-submit';
export const TLS_CERTS_UPLOAD_CANCEL_BTN_ATTR = 'data-recued-tls-certs-upload-cancel';
export const TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR = 'data-recued-tls-certs-upload-draft-status';
/** One node per validator issue, attr value = the closed-list issue code. */
export const TLS_CERTS_ISSUE_ATTR = 'data-recued-tls-certs-issue';
export const TLS_CERTS_RESULT_ATTR = 'data-recued-tls-certs-result';
export const TLS_CERTS_REMOVE_OPEN_BTN_ATTR = 'data-recued-tls-certs-remove-open';
export const TLS_CERTS_REMOVE_CONFIRM_BTN_ATTR = 'data-recued-tls-certs-remove-confirm';
export const TLS_CERTS_REMOVE_CANCEL_BTN_ATTR = 'data-recued-tls-certs-remove-cancel';

export type TlsDomainListCaller = () => Promise<{
  entries: ReadonlyArray<TLSDomainCertListEntry>;
}>;
export type TlsDomainUploadCaller = (
  req: TLSDomainUploadInput,
) => Promise<TLSDomainUploadResult>;
export type TlsDomainRemoveCaller = (req: {
  domain: string;
}) => Promise<{ removed: boolean }>;

export interface MountTlsCertificatesPanelOptions {
  host: HTMLElement;
  document?: Document;
  runList: TlsDomainListCaller;
  runUpload: TlsDomainUploadCaller;
  /** Absent → rows render without a Remove action. Removal is a separate
   *  capability from upload; a host that wires only one gets only one. */
  runRemove?: TlsDomainRemoveCaller;
  /** `Date.now`-compatible clock for the expiry severity + relative copy.
   *  Tests pin it so the rendered copy is deterministic. */
  now?: () => number;
  /** Invoked after a successful upload so the host can refresh sibling
   *  surfaces (the Hostnames panel's cert-expiry chip reads the same certs).
   *  Best-effort — a throw is swallowed. */
  onUploaded?: (domain: string, result: TLSDomainUploadResult) => void;
}

export interface TlsCertificatesUploadFormValues {
  domain: string;
  cert_pem: string;
  private_key_pem: string;
  chain_pem: string;
}

export interface TlsCertificatesPanelState {
  loading: boolean;
  error: string | null;
  model: TLSCertificatesPageModel | null;
  upload: {
    open: boolean;
    saving: boolean;
    error: string | null;
    issues: ReadonlyArray<{ code: TLSDomainUploadIssue['code']; copy: string }>;
    result: TLSDomainUploadResult | null;
    values: TlsCertificatesUploadFormValues;
  };
  remove: {
    domain: string | null;
    saving: boolean;
    error: string | null;
  };
}

export interface TlsCertificatesPanelMount {
  getState(): TlsCertificatesPanelState;
  hasUnsavedChanges(): boolean;
  hasInFlightWork(): boolean;
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  dispose(): void;
  openUpload(domain?: string): void;
  cancelUpload(): void;
  setUploadField(
    field: keyof TlsCertificatesUploadFormValues,
    value: string,
  ): void;
  submitUpload(): Promise<void>;
  openRemove(domain: string): void;
  cancelRemove(): void;
  confirmRemove(): Promise<void>;
}

const EMPTY_UPLOAD_VALUES: TlsCertificatesUploadFormValues = {
  domain: '',
  cert_pem: '',
  private_key_pem: '',
  chain_pem: '',
};

/** Pull the structured issue array off an `RpcError`.
 *
 *  Read STRUCTURALLY rather than via `instanceof RpcError`: the webclient
 *  bundle and the contracts package can resolve to distinct class identities,
 *  and an `instanceof` miss here degrades silently into "no inline issues" —
 *  the user would see a generic failure for a cert we know exactly what is
 *  wrong with. Unknown codes are dropped (a server ahead of this client can
 *  name an issue whose copy we do not have) and the caller falls back to the
 *  humanized message when nothing survives. */
export const extractUploadIssues = (
  err: unknown,
): ReadonlyArray<{ code: TLSDomainUploadIssue['code']; copy: string }> => {
  const details = (err as { details?: unknown } | null | undefined)?.details;
  if (typeof details !== 'object' || details === null) return [];
  const raw = (details as { issues?: unknown }).issues;
  if (!Array.isArray(raw)) return [];
  const issues: TLSDomainUploadIssue[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const code = (item as { code?: unknown }).code;
    if (typeof code !== 'string') continue;
    if (!Object.prototype.hasOwnProperty.call(TLS_UPLOAD_ISSUE_COPY, code)) continue;
    issues.push({ code } as TLSDomainUploadIssue);
  }
  if (issues.length === 0) return [];
  // Reuse the tested projection rather than re-implementing the code→copy
  // mapping here — one mapping, one place it can be wrong.
  return projectUploadValidation({ ok: false, issues }).issues;
};

let nextTlsUploadValidationId = 0;

export const mountTlsCertificatesPanel = (
  opts: MountTlsCertificatesPanelOptions,
): TlsCertificatesPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountTlsCertificatesPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }
  const now = opts.now ?? Date.now;

  let state: TlsCertificatesPanelState = {
    loading: true,
    error: null,
    model: null,
    upload: {
      open: false,
      saving: false,
      error: null,
      issues: [],
      result: null,
      values: { ...EMPTY_UPLOAD_VALUES },
    },
    remove: { domain: null, saving: false, error: null },
  };
  let disposed = false;
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  let loadStarted = false;
  let readFocusTarget: HTMLElement | null = null;
  const uploadReplaceButtons = new Map<string, HTMLButtonElement>();
  const removeOpenButtons = new Map<string, HTMLButtonElement>();
  let removeCancelButton: HTMLButtonElement | null = null;
  let uploadSubmitButton: HTMLButtonElement | null = null;
  let uploadCancelButton: HTMLButtonElement | null = null;
  let uploadForm: HTMLElement | null = null;
  let uploadFeedback: HTMLElement | null = null;
  let uploadResultMessage: HTMLElement | null = null;
  let uploadOpenButton: HTMLButtonElement | null = null;
  let uploadSeedDomain = '';
  let uploadFormGeneration = 0;
  let uploadFileRevision = 0;
  let uploadResultDomain: string | null = null;
  let earlierUploadFailureDomain: string | null = null;
  let lastRemoval: { domain: string; removed: boolean } | null = null;

  const wrapper = doc.createElement('div');
  wrapper.setAttribute(TLS_CERTS_PANEL_ATTR, '');
  wrapper.className = 'tls-certs-panel';
  opts.host.appendChild(wrapper);

  // Reads replace only this region. Upload inputs stay mounted so a Retry
  // cannot interrupt typing, selection, composition, undo, or a file import.
  const inventory = doc.createElement('div');
  inventory.className = 'tls-certs-inventory';
  wrapper.appendChild(inventory);
  const writeResults = doc.createElement('div');
  writeResults.className = 'tls-certs-write-results';
  wrapper.appendChild(writeResults);
  const uploadHost = doc.createElement('div');
  uploadHost.className = 'tls-certs-upload-host';
  wrapper.appendChild(uploadHost);
  const uploadActions = doc.createElement('div');
  uploadActions.className = 'tls-certs-upload-actions';
  wrapper.appendChild(uploadActions);

  const uploadFields = new Map<
    keyof TlsCertificatesUploadFormValues,
    HTMLInputElement | HTMLTextAreaElement
  >();
  const uploadFiles = new Map<keyof TlsCertificatesUploadFormValues, HTMLInputElement>();
  const uploadFieldHosts = new Map<keyof TlsCertificatesUploadFormValues, HTMLElement>();
  const pendingFileReads = new Map<keyof TlsCertificatesUploadFormValues, FileReader>();
  const uploadValidationId = `tls-certs-upload-validation-${++nextTlsUploadValidationId}`;
  // Only the local gates identify a field; server refusals use shared feedback.
  let localUploadErrorField: keyof TlsCertificatesUploadFormValues | null = null;
  let uploadInvalidControl: { input: HTMLInputElement | HTMLTextAreaElement; messageId: string } | null = null;
  let uploadMessages: HTMLElement[] = [];

  const hasUploadDraft = (): boolean => state.upload.open && (
    state.upload.values.domain !== uploadSeedDomain
    || state.upload.values.cert_pem !== ''
    || state.upload.values.private_key_pem !== ''
    || state.upload.values.chain_pem !== ''
    // A selected file is a draft before its read completes, including an empty file.
    || [...uploadFiles.values()].some(file => (file.files?.length ?? 0) > 0)
  );

  const updateUploadResultMessage = (): void => {
    if (uploadResultMessage === null) return;
    const retainedForm = state.upload.open && uploadResultDomain !== null;
    const newerDraft = retainedForm && hasUploadDraft();
    const text = retainedForm
      ? `Certificate installed for ${uploadResultDomain}.${newerDraft ? ' Your newer edits still need uploading.' : ''}`
      : 'Certificate installed.';
    if (uploadResultMessage.textContent !== text) uploadResultMessage.textContent = text;
    if (newerDraft) uploadResultMessage.setAttribute(TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR, '');
    else uploadResultMessage.removeAttribute(TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR);
  };

  const clearUploadMessages = (): void => {
    for (const message of uploadMessages) message.remove();
    uploadMessages = [];
    if (uploadInvalidControl !== null) {
      const { input, messageId } = uploadInvalidControl;
      input.removeAttribute('aria-invalid');
      const descriptions = (input.getAttribute('aria-describedby') ?? '').split(/\s+/)
        .filter(id => id !== '' && id !== messageId);
      if (descriptions.length > 0) input.setAttribute('aria-describedby', descriptions.join(' '));
      else input.removeAttribute('aria-describedby');
      uploadInvalidControl = null;
    }
  };

  const clearChildren = (el: HTMLElement): void => {
    while (el.firstChild) el.removeChild(el.firstChild);
  };

  const retireUploadForm = (): void => {
    uploadFormGeneration++;
    clearUploadMessages();
    localUploadErrorField = null;
    uploadForm?.remove();
    uploadForm = null;
    uploadFeedback = null;
    uploadFields.clear();
    uploadFiles.clear();
    uploadFieldHosts.clear();
    pendingFileReads.clear();
    uploadSubmitButton = null;
    uploadCancelButton = null;
  };

  const makeButton = (
    label: string,
    attr: string,
    variant: 'primary' | 'secondary' | 'danger',
    onClick: () => void,
    disabled = false,
    attrValue = '',
  ): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `rx-btn rx-btn-${variant} rx-btn-sm`;
    btn.textContent = label;
    btn.setAttribute(attr, attrValue);
    const writeAction = attr === TLS_CERTS_UPLOAD_OPEN_BTN_ATTR ||
      attr === TLS_CERTS_UPLOAD_SUBMIT_BTN_ATTR || attr === TLS_CERTS_REMOVE_OPEN_BTN_ATTR ||
      attr === TLS_CERTS_REMOVE_CONFIRM_BTN_ATTR;
    btn.disabled = disabled || (writeAction && (state.loading || state.upload.saving || state.remove.saving));
    btn.addEventListener('click', () => {
      if (disposed || btn.disabled || btn.isConnected === false) return;
      onClick();
    });
    if (attr === TLS_CERTS_UPLOAD_SUBMIT_BTN_ATTR) uploadSubmitButton = btn;
    if (attr === TLS_CERTS_UPLOAD_OPEN_BTN_ATTR && attrValue === '') uploadOpenButton = btn;
    return btn;
  };

  const focusButton = (button: HTMLButtonElement | null | undefined): boolean => {
    if (!button || button.disabled || button.isConnected === false) return false;
    button.focus?.();
    return true;
  };

  const openUploadFrom = (button: HTMLButtonElement, domain?: string): void => {
    const keepFocus = doc.activeElement === button;
    handle.openUpload(domain);
    if (keepFocus) uploadFields.get('domain')?.focus?.();
  };

  const makeNote = (
    text: string,
    className: string,
    attr?: string,
  ): HTMLParagraphElement => {
    const p = doc.createElement('p');
    p.className = className;
    p.textContent = text;
    if (attr !== undefined) {
      p.setAttribute(attr, '');
      if (attr === TLS_CERTS_ERROR_ATTR) p.setAttribute('role', 'alert');
    }
    return p;
  };

  const makeMetaPair = (
    parent: HTMLElement,
    label: string,
    value: string,
    mono = false,
  ): void => {
    const cell = doc.createElement('div');
    const l = doc.createElement('span');
    l.className = 'tls-certs-meta-label';
    l.textContent = label;
    const v = doc.createElement('span');
    v.className = mono ? 'tls-certs-meta-value tls-certs-mono' : 'tls-certs-meta-value';
    v.textContent = value;
    cell.appendChild(l);
    cell.appendChild(v);
    parent.appendChild(cell);
  };

  /** Textarea + a file picker that fills it.
   *
   *  The TEXTAREA is the load-bearing control, not the file input: a PEM is
   *  routinely pasted out of a terminal or a CA's web console, the file input
   *  is unreachable from a scripted test, and `FileReader` is not guaranteed
   *  to exist in every host we mount under. The picker only ever WRITES into
   *  the textarea, so both paths converge on one value. */
  const makePemField = (
    field: keyof TlsCertificatesUploadFormValues,
    labelText: string,
    placeholder: string,
    onInput: (value: string) => void,
  ): HTMLElement => {
    const wrap = doc.createElement('div');
    wrap.className = 'tls-certs-field';

    const label = doc.createElement('label');
    const span = doc.createElement('span');
    span.className = 'tls-certs-field-label';
    span.textContent = labelText;
    label.appendChild(span);

    const area = doc.createElement('textarea');
    area.setAttribute('spellcheck', 'false');
    area.setAttribute('autocapitalize', 'none');
    area.setAttribute('autocorrect', 'off');
    area.className = 'tls-certs-textarea tls-certs-mono';
    area.rows = 5;
    area.placeholder = placeholder;
    area.value = state.upload.values[field];
    area.setAttribute(TLS_CERTS_UPLOAD_FIELD_ATTR, field);
    uploadFields.set(field, area);
    area.addEventListener('input', () => {
      if (uploadFields.get(field) === area) onInput(area.value);
    });
    label.appendChild(area);
    wrap.appendChild(label);
    uploadFieldHosts.set(field, wrap);

    const file = doc.createElement('input');
    file.type = 'file';
    file.setAttribute('aria-label', `Choose file: ${labelText}`);
    file.className = 'tls-certs-file';
    file.setAttribute(TLS_CERTS_UPLOAD_FILE_ATTR, field);
    uploadFiles.set(field, file);
    file.addEventListener('change', () => {
      if (disposed || !state.upload.open || uploadFiles.get(field) !== file) return;
      uploadFileRevision++;
      pendingFileReads.delete(field);
      updateUploadResultMessage();
      const picked = (file as { files?: { length: number; [i: number]: unknown } | null }).files;
      const first = picked && picked.length > 0 ? picked[0] : null;
      if (first === null || first === undefined) return;
      const ReaderCtor = (globalThis as { FileReader?: typeof FileReader }).FileReader;
      if (ReaderCtor === undefined) return;
      const reader = new ReaderCtor();
      pendingFileReads.set(field, reader);
      reader.addEventListener('load', () => {
        // Only the latest choice for this live field may complete. Cancel,
        // reopening, clearing the picker, or typing retires the older read.
        if (disposed || !state.upload.open || uploadFiles.get(field) !== file
          || pendingFileReads.get(field) !== reader) return;
        pendingFileReads.delete(field);
        const text = typeof reader.result === 'string' ? reader.result : '';
        if (text === '') return;
        // Route through the same setter the textarea uses so the draft,
        // visible value and validation feedback stay in sync.
        handle.setUploadField(field, text);
      });
      reader.addEventListener('loadend', () => {
        if (pendingFileReads.get(field) === reader) pendingFileReads.delete(field);
      });
      reader.readAsText(first as Blob);
    });
    wrap.appendChild(file);
    return wrap;
  };

  const renderRows = (): void => {
    const model = state.model;
    if (model === null) return;
    if (model.rows.length === 0) {
      if (state.error !== null) return;
      inventory.appendChild(
        makeNote(
          'No certificates installed. Upload one for any hostname whose cert source is "Upload my own certificate".',
          'tls-certs-muted',
          TLS_CERTS_EMPTY_ATTR,
        ),
      );
      return;
    }

    const list = doc.createElement('div');
    list.className = 'tls-certs-list';
    for (const row of model.rows) {
      const el = doc.createElement('div');
      el.className = 'tls-certs-row';
      el.setAttribute(TLS_CERTS_ROW_ATTR, row.domain);
      el.setAttribute(TLS_CERTS_ROW_SEVERITY_ATTR, row.severity);

      const head = doc.createElement('div');
      head.className = 'tls-certs-row-main';
      const name = doc.createElement('span');
      name.className = 'tls-certs-row-name';
      name.textContent = row.domain;
      head.appendChild(name);
      const badge = doc.createElement('span');
      badge.className = `tls-certs-chip tls-certs-chip-${row.severity}`;
      badge.textContent =
        row.severity === 'expired'
          ? 'expired'
          : `expires in ${row.days_until_expiry} days`;
      head.appendChild(badge);
      el.appendChild(head);

      const meta = doc.createElement('div');
      meta.className = 'tls-certs-row-meta';
      makeMetaPair(meta, 'Source', row.source_label);
      makeMetaPair(meta, 'Issuer', row.issuer);
      makeMetaPair(meta, 'Fingerprint', row.fingerprint_short, true);
      makeMetaPair(
        meta,
        'Expires',
        formatClientDateTime(row.expires_at, { invalidText: 'unknown' }),
      );
      el.appendChild(meta);

      if (row.manual_renewal_hint) {
        el.appendChild(
          makeNote(
            'Uploaded certificates do not auto-renew. Renew with your issuer, then upload the replacement here.',
            'tls-certs-muted',
          ),
        );
      }

      const actions = doc.createElement('div');
      actions.className = 'tls-certs-actions';
      const replace = makeButton('Replace', TLS_CERTS_UPLOAD_OPEN_BTN_ATTR, 'secondary', () => {
        openUploadFrom(replace, row.domain);
      }, false, row.domain);
      uploadReplaceButtons.set(row.domain, replace);
      actions.appendChild(replace);
      if (opts.runRemove !== undefined) {
        const remove = makeButton('Remove', TLS_CERTS_REMOVE_OPEN_BTN_ATTR, 'danger', () => {
          // Carry focus only when this action owned it before the row was rebuilt.
          const keepFocus = doc.activeElement === remove;
          handle.openRemove(row.domain);
          if (keepFocus) focusButton(removeCancelButton);
        }, false, row.domain);
        removeOpenButtons.set(row.domain, remove);
        actions.appendChild(remove);
      }
      el.appendChild(actions);

      if (state.remove.domain === row.domain) {
        const confirm = doc.createElement('div');
        confirm.className = 'tls-certs-confirm';
        confirm.appendChild(
          makeNote(
            `Remove the certificate for ${row.domain}? TLS connections to this hostname will stop working until a replacement is uploaded.`,
            'tls-certs-muted',
          ),
        );
        if (state.remove.error !== null) {
          confirm.appendChild(
            makeNote(state.remove.error, 'tls-certs-error', TLS_CERTS_ERROR_ATTR),
          );
        }
        const confirmActions = doc.createElement('div');
        confirmActions.className = 'tls-certs-actions';
        const cancel = makeButton('Cancel', TLS_CERTS_REMOVE_CANCEL_BTN_ATTR, 'secondary', () => {
          const keepFocus = doc.activeElement === cancel;
          handle.cancelRemove();
          if (keepFocus) focusButton(removeOpenButtons.get(row.domain));
        }, state.remove.saving);
        removeCancelButton = cancel;
        confirmActions.appendChild(cancel);
        confirmActions.appendChild(
          makeButton(
            state.remove.saving ? 'Removing…' : 'Remove certificate',
            TLS_CERTS_REMOVE_CONFIRM_BTN_ATTR,
            'danger',
            () => {
              void handle.confirmRemove();
            },
            state.remove.saving,
          ),
        );
        confirm.appendChild(confirmActions);
        el.appendChild(confirm);
      }

      list.appendChild(el);
    }
    inventory.appendChild(list);
  };

  const updateUploadForm = (): void => {
    if (uploadFeedback === null) return;
    clearUploadMessages();
    clearChildren(uploadFeedback);
    if (earlierUploadFailureDomain !== null) {
      const message = makeNote(
        `The submitted upload for ${earlierUploadFailureDomain} failed. Your newer edits still need uploading.`,
        'tls-certs-muted', TLS_CERTS_UPLOAD_DRAFT_STATUS_ATTR,
      );
      message.setAttribute('role', 'status');
      message.setAttribute('aria-atomic', 'true');
      uploadMessages.push(message);
      uploadFeedback.appendChild(message);
    }
    if (state.upload.error !== null) {
      const message = makeNote(state.upload.error, 'tls-certs-error', TLS_CERTS_ERROR_ATTR);
      uploadMessages.push(message);
      const input = localUploadErrorField === null ? undefined : uploadFields.get(localUploadErrorField);
      const fieldHost = localUploadErrorField === null ? undefined : uploadFieldHosts.get(localUploadErrorField);
      if (input && fieldHost) {
        const messageId = `${uploadValidationId}-${localUploadErrorField}`;
        message.setAttribute('id', messageId);
        input.setAttribute('aria-invalid', 'true');
        const descriptions = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        input.setAttribute('aria-describedby', [...new Set([...descriptions, messageId])].join(' '));
        uploadInvalidControl = { input, messageId };
        fieldHost.appendChild(message);
      } else uploadFeedback.appendChild(message);
    }
    for (const issue of state.upload.issues) {
      const message = makeNote(issue.copy, 'tls-certs-issue');
      message.setAttribute(TLS_CERTS_ISSUE_ATTR, issue.code);
      uploadMessages.push(message);
      uploadFeedback.appendChild(message);
    }
    if (uploadSubmitButton) {
      uploadSubmitButton.disabled = state.loading || state.upload.saving || state.remove.saving;
      const label = state.upload.saving ? 'Uploading…' : 'Upload certificate';
      if (uploadSubmitButton.textContent !== label) uploadSubmitButton.textContent = label;
    }
    if (uploadCancelButton) uploadCancelButton.disabled = state.upload.saving;
  };

  const renderUploadForm = (): void => {
    if (!state.upload.open) { retireUploadForm(); return; }
    if (uploadForm !== null) { updateUploadForm(); return; }
    const form = doc.createElement('div');
    uploadForm = form;
    form.className = 'tls-certs-form';
    form.setAttribute(TLS_CERTS_UPLOAD_FORM_ATTR, '');

    const heading = doc.createElement('h3');
    heading.className = 'tls-certs-form-title';
    heading.textContent = 'Certificate details';
    form.appendChild(heading);

    form.appendChild(
      makeNote(
        'Paste the PEM blocks, or pick the files. The private key is encrypted at rest on this server and is never sent to the cloud.',
        'tls-certs-muted',
      ),
    );

    uploadFeedback = doc.createElement('div');
    uploadFeedback.className = 'tls-certs-upload-feedback';
    form.appendChild(uploadFeedback);

    const domainWrap = doc.createElement('div');
    domainWrap.className = 'tls-certs-field';
    const domainLabel = doc.createElement('label');
    const domainSpan = doc.createElement('span');
    domainSpan.className = 'tls-certs-field-label';
    domainSpan.textContent = 'Hostname';
    domainLabel.appendChild(domainSpan);
    const domainInput = doc.createElement('input');
    domainInput.type = 'text';
    domainInput.setAttribute('spellcheck', 'false');
    domainInput.setAttribute('autocapitalize', 'none');
    domainInput.setAttribute('autocorrect', 'off');
    domainInput.className = 'tls-certs-input';
    domainInput.placeholder = 'server.example.com';
    domainInput.value = state.upload.values.domain;
    domainInput.setAttribute(TLS_CERTS_UPLOAD_FIELD_ATTR, 'domain');
    uploadFields.set('domain', domainInput);
    domainInput.addEventListener('input', () => {
      if (uploadFields.get('domain') === domainInput) handle.setUploadField('domain', domainInput.value);
    });
    domainLabel.appendChild(domainInput);
    domainWrap.appendChild(domainLabel);
    uploadFieldHosts.set('domain', domainWrap);
    form.appendChild(domainWrap);

    form.appendChild(
      makePemField(
        'cert_pem',
        'Certificate (PEM)',
        '-----BEGIN CERTIFICATE-----',
        (value) => { handle.setUploadField('cert_pem', value); },
      ),
    );
    form.appendChild(
      makePemField(
        'private_key_pem',
        'Private key (PEM)',
        '-----BEGIN PRIVATE KEY-----',
        (value) => { handle.setUploadField('private_key_pem', value); },
      ),
    );
    form.appendChild(
      makePemField(
        'chain_pem',
        'Issuer chain (PEM, optional)',
        '-----BEGIN CERTIFICATE-----',
        (value) => { handle.setUploadField('chain_pem', value); },
      ),
    );

    const actions = doc.createElement('div');
    actions.className = 'tls-certs-actions';
    uploadCancelButton = makeButton('Cancel', TLS_CERTS_UPLOAD_CANCEL_BTN_ATTR, 'secondary', () => {
      const keepFocus = doc.activeElement === uploadCancelButton;
      const origin = uploadSeedDomain;
      handle.cancelUpload();
      if (keepFocus && !focusButton(uploadReplaceButtons.get(origin) ?? uploadOpenButton)) focusReadTarget();
    }, state.upload.saving);
    actions.appendChild(uploadCancelButton);
    uploadSubmitButton = makeButton(
      state.upload.saving ? 'Uploading…' : 'Upload certificate',
      TLS_CERTS_UPLOAD_SUBMIT_BTN_ATTR,
      'primary',
      () => {
        void handle.submitUpload();
      },
      state.upload.saving,
    );
    actions.appendChild(uploadSubmitButton);
    form.appendChild(actions);
    uploadHost.appendChild(form);
    updateUploadForm();
  };

  const focusReadTarget = (): void => {
    if (readFocusTarget && readFocusTarget.isConnected !== false &&
        (readFocusTarget.getClientRects?.().length ?? 1) > 0) readFocusTarget.focus?.();
  };

  const renderInventory = (keepFocus = doc.activeElement != null &&
    inventory.contains?.(doc.activeElement) === true): void => {
    if (disposed) return;
    uploadReplaceButtons.clear();
    removeOpenButtons.clear();
    removeCancelButton = null;
    clearChildren(inventory);

    const heading = doc.createElement('h3');
    heading.className = 'tls-certs-title';
    heading.textContent = 'Installed certificates';
    heading.setAttribute(TLS_CERTS_READ_HEADING_ATTR, '');
    heading.setAttribute('tabindex', '-1');
    inventory.appendChild(heading);
    readFocusTarget = heading;
    inventory.setAttribute('aria-busy', String(state.loading));
    const writesBlocked = state.loading || state.upload.saving || state.remove.saving;
    if (uploadSubmitButton) uploadSubmitButton.disabled = writesBlocked;
    if (uploadOpenButton) uploadOpenButton.disabled = writesBlocked;

    if (state.loading) {
      const status = makeNote('Loading certificates…', 'tls-certs-muted', TLS_CERTS_STATUS_ATTR);
      status.setAttribute('role', 'status');
      status.setAttribute('aria-atomic', 'true');
      status.setAttribute('tabindex', '-1');
      inventory.appendChild(status);
      readFocusTarget = status;
      if (keepFocus) focusReadTarget();
      return;
    }
    if (state.error !== null) {
      const refreshing = state.model !== null || state.upload.result !== null || lastRemoval !== null;
      inventory.appendChild(
        makeNote(`${refreshing ? 'Could not refresh certificates.' : 'Could not load certificates.'} ${state.error}`,
          'tls-certs-error', TLS_CERTS_ERROR_ATTR),
      );
      const retry = makeButton('Retry', TLS_CERTS_READ_RETRY_ATTR, 'secondary', () => {
        if (readFocusTarget !== retry) return;
        void load();
      }, state.upload.saving || state.remove.saving);
      retry.setAttribute('aria-label', 'Retry loading certificates');
      inventory.appendChild(retry);
      readFocusTarget = retry;
      if (state.model !== null && state.model.rows.length > 0) {
        inventory.appendChild(makeNote('These certificates were loaded earlier. Retry to check for changes.',
          'tls-certs-muted', TLS_CERTS_STALE_ATTR));
      }
    }
    renderRows();
    if (keepFocus) focusReadTarget();
  };

  const render = (): void => {
    if (disposed) return;
    const keepReadFocus = readFocusTarget !== null && doc.activeElement === readFocusTarget;
    uploadOpenButton = null;
    // Keep the native form connected through validation and write feedback:
    // rebuilding it would discard selected files and their draft guard.
    uploadResultMessage = null;
    clearChildren(writeResults);
    clearChildren(uploadActions);
    renderInventory(false);

    if (lastRemoval !== null) {
      const result = makeNote(lastRemoval.removed
        ? `Certificate removed for ${lastRemoval.domain}.`
        : `No certificate is installed for ${lastRemoval.domain}.`,
      'tls-certs-ok', TLS_CERTS_REMOVAL_RESULT_ATTR);
      result.setAttribute('role', 'status');
      result.setAttribute('aria-atomic', 'true');
      writeResults.appendChild(result);
    }

    if (state.upload.result !== null) {
      const result = state.upload.result;
      const block = doc.createElement('div');
      block.className = 'tls-certs-result';
      block.setAttribute(TLS_CERTS_RESULT_ATTR, '');
      const meta = doc.createElement('div');
      meta.className = 'tls-certs-row-meta';
      makeMetaPair(meta, 'Fingerprint', result.fingerprint, true);
      makeMetaPair(
        meta,
        'Expires',
        formatClientDateTime(result.expires_at, { invalidText: 'unknown' }),
      );
      makeMetaPair(meta, 'Covers', result.san.join(', ') || 'none');
      const message = makeNote('', 'tls-certs-ok');
      uploadResultMessage = message;
      updateUploadResultMessage();
      message.setAttribute('role', 'status');
      message.setAttribute('aria-atomic', 'true');
      block.appendChild(message);
      block.appendChild(meta);
      writeResults.appendChild(block);
    }

    renderUploadForm();

    if (!state.upload.open) {
      const actions = doc.createElement('div');
      actions.className = 'tls-certs-actions';
      const open = makeButton('Upload a certificate', TLS_CERTS_UPLOAD_OPEN_BTN_ATTR, 'primary', () => {
        openUploadFrom(open);
      }, state.loading || state.upload.saving || state.remove.saving);
      uploadOpenButton = open;
      actions.appendChild(open);
      uploadActions.appendChild(actions);
    }
    if (keepReadFocus) focusReadTarget();
  };

  const load = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if ((loadStarted && state.loading) || state.upload.saving || state.remove.saving) return pendingLoad;
    loadStarted = true;
    const gen = ++loadGeneration;
    state = { ...state, loading: true, error: null };
    renderInventory();
    pendingLoad = (async () => {
      try {
        const res = await opts.runList();
        if (disposed || gen !== loadGeneration) return;
        state = {
          ...state,
          loading: false,
          error: null,
          model: buildTLSCertificatesPageModel({
            entries: res.entries,
            now_ms: now(),
          }),
        };
      } catch (err) {
        if (disposed || gen !== loadGeneration) return;
        state = { ...state, loading: false, error: humanizeRpcError(err) };
      }
      renderInventory();
    })();
    return pendingLoad;
  };

  const handle: TlsCertificatesPanelMount = {
    getState: () => state,
    hasUnsavedChanges: () => !disposed && hasUploadDraft(),
    hasInFlightWork: () => !disposed && (state.upload.saving || state.remove.saving),
    refresh: () => load(),
    whenLoaded: () => pendingLoad,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      uploadReplaceButtons.clear();
      removeOpenButtons.clear();
      removeCancelButton = null;
      uploadResultDomain = null;
      earlierUploadFailureDomain = null;
      uploadResultMessage = null;
      retireUploadForm();
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    },

    openUpload: (domain) => {
      if (disposed || state.loading || state.upload.saving || state.remove.saving) return;
      retireUploadForm();
      uploadSeedDomain = domain ?? '';
      uploadResultDomain = null;
      earlierUploadFailureDomain = null;
      lastRemoval = null;
      state = {
        ...state,
        upload: {
          open: true,
          saving: false,
          error: null,
          issues: [],
          result: null,
          values: { ...EMPTY_UPLOAD_VALUES, ...(domain !== undefined ? { domain } : {}) },
        },
        remove: { domain: null, saving: false, error: null },
      };
      render();
    },

    cancelUpload: () => {
      if (disposed) return;
      uploadSeedDomain = '';
      uploadResultDomain = null;
      earlierUploadFailureDomain = null;
      state = {
        ...state,
        upload: {
          open: false,
          saving: false,
          error: null,
          issues: [],
          result: null,
          values: { ...EMPTY_UPLOAD_VALUES },
        },
      };
      render();
    },

    setUploadField: (field, value) => {
      if (disposed) return;
      pendingFileReads.delete(field);
      localUploadErrorField = null;
      earlierUploadFailureDomain = null;
      state = {
        ...state,
        upload: {
          ...state.upload,
          error: null,
          issues: [],
          values: { ...state.upload.values, [field]: value },
        },
      };
      // Keep the browser-owned editing control mounted: replacing it loses
      // focus, selection, composition and undo history after the first input.
      // File imports and public setters also update the visible control, but
      // a native input event already put its value there; do not reassign it.
      const input = uploadFields.get(field);
      if (input !== undefined && input.value !== value) input.value = value;
      clearUploadMessages();
      updateUploadResultMessage();
    },

    submitUpload: async () => {
      if (disposed || !state.upload.open || state.loading || state.upload.saving || state.remove.saving) return;
      earlierUploadFailureDomain = null;
      const values = { ...state.upload.values };
      const domain = values.domain.trim();
      const cert_pem = values.cert_pem.trim();
      const private_key_pem = values.private_key_pem.trim();
      const chain_pem = values.chain_pem.trim();

      // Cheap shape checks only. The AUTHORITATIVE parse is server-side
      // (`node:crypto` X509 + the SAN / key-pair / chain / expiry gates); this
      // exists so an empty or obviously-not-PEM paste gets an answer without a
      // round trip, not to duplicate the validator.
      const complaint: { field: keyof TlsCertificatesUploadFormValues; copy: string } | null =
        domain === ''
          ? { field: 'domain', copy: 'You need to give a name.' }
          : !cert_pem.includes('-----BEGIN ')
            ? { field: 'cert_pem', copy: 'Certificate must be a PEM block beginning with "-----BEGIN CERTIFICATE-----".' }
            : !private_key_pem.includes('-----BEGIN ')
              ? { field: 'private_key_pem', copy: 'Private key must be a PEM block beginning with "-----BEGIN".' }
              : chain_pem !== '' && !chain_pem.includes('-----BEGIN ')
                ? { field: 'chain_pem', copy: 'Issuer chain must be a PEM block when provided.' }
                : null;
      if (complaint !== null) {
        localUploadErrorField = complaint.field;
        state = { ...state, upload: { ...state.upload, error: complaint.copy, issues: [] } };
        render();
        uploadFields.get(complaint.field)?.focus?.();
        return;
      }

      const generation = uploadFormGeneration;
      const fileRevision = uploadFileRevision;
      const hadPendingFileRead = pendingFileReads.size > 0;
      // File choices may change without changing text (an empty or still-reading file).
      // Compare the live values with this request's snapshot as well as file intent.
      const hasNewerDraft = (): boolean => hadPendingFileRead || fileRevision !== uploadFileRevision ||
        (Object.keys(values) as Array<keyof TlsCertificatesUploadFormValues>)
          .some(field => state.upload.values[field] !== values[field]);
      localUploadErrorField = null;
      uploadResultDomain = null;
      state = {
        ...state,
        upload: { ...state.upload, saving: true, error: null, issues: [], result: null },
      };
      render();

      try {
        const result = await opts.runUpload({
          domain,
          cert_pem,
          private_key_pem,
          ...(chain_pem !== '' ? { chain_pem } : {}),
          // Pinned — see the header note above.
          source: 'byo_upload',
        });
        if (disposed || generation !== uploadFormGeneration) return;
        const keepDraft = hasNewerDraft();
        if (!keepDraft) uploadSeedDomain = '';
        uploadResultDomain = domain;
        state = {
          ...state,
          model: null,
          error: null,
          upload: {
            open: keepDraft,
            saving: false,
            error: null,
            issues: [],
            result,
            // Clear completed PEMs when the draft is unchanged. Newer values
            // and file reads still belong to the user's unsaved draft.
            values: keepDraft ? state.upload.values : { ...EMPTY_UPLOAD_VALUES },
          },
        };
        lastRemoval = null;
        render();
        if (opts.onUploaded !== undefined) {
          try {
            opts.onUploaded(domain, result);
          } catch {
            /* best-effort host hook */
          }
        }
        await load();
        return;
      } catch (err) {
        if (disposed || generation !== uploadFormGeneration) return;
        earlierUploadFailureDomain = hasNewerDraft() ? domain : null;
        const issues = extractUploadIssues(err);
        state = {
          ...state,
          upload: {
            ...state.upload,
            saving: false,
            // When the server named specific gates, the inline issue lines ARE
            // the message; a humanized duplicate above them just says the same
            // thing worse.
            error: issues.length > 0 ? null : humanizeRpcError(err),
            issues,
          },
        };
      }
      render();
    },

    openRemove: (domain) => {
      if (disposed || state.loading || state.upload.saving || state.remove.saving) return;
      lastRemoval = null;
      state = { ...state, remove: { domain, saving: false, error: null } };
      render();
    },

    cancelRemove: () => {
      if (disposed) return;
      state = { ...state, remove: { domain: null, saving: false, error: null } };
      render();
    },

    confirmRemove: async () => {
      if (disposed || state.loading || state.remove.saving || state.upload.saving) return;
      const domain = state.remove.domain;
      const runRemove = opts.runRemove;
      if (domain === null || runRemove === undefined) return;
      state = { ...state, remove: { ...state.remove, saving: true, error: null } };
      render();
      try {
        const result = await runRemove({ domain });
        if (disposed) return;
        lastRemoval = { domain, removed: result.removed };
        state = {
          ...state,
          model: null,
          error: null,
          remove: { domain: null, saving: false, error: null },
          upload: { ...state.upload, result: null },
        };
        render();
        await load();
        return;
      } catch (err) {
        if (disposed) return;
        state = {
          ...state,
          remove: { ...state.remove, saving: false, error: humanizeRpcError(err) },
        };
      }
      render();
    },
  };

  render();
  void load();
  return handle;
};

export const TLS_CERTIFICATES_PANEL_STYLES = `
[${TLS_CERTS_PANEL_ATTR}],
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-inventory {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
[${TLS_CERTS_PANEL_ATTR}] {
  font-size: 13px;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-write-results,
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-upload-host,
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-upload-actions,
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-upload-feedback {
  display: contents;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-muted {
  margin: 0;
  color: var(--muted-fg);
  line-height: 1.45;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-ok {
  margin: 0;
  font-weight: 600;
  color: var(--ok-fg);
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-error,
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-issue {
  margin: 0;
  border-radius: 6px;
  background: var(--danger-bg);
  color: var(--danger);
  padding: 8px;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-row,
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-form,
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-result {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--surface);
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-row-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-row-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-row-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-meta-label,
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-field-label {
  display: block;
  color: var(--muted-fg);
  font-size: 11px;
  margin-bottom: 3px;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-meta-value {
  overflow-wrap: anywhere;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  word-break: break-all;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-chip {
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-chip-healthy {
  background: var(--ok-bg);
  color: var(--ok-fg);
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-chip-expiring_soon,
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-chip-expiring_critical {
  background: var(--warn-bg);
  color: var(--warn);
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-chip-expired {
  background: var(--danger-bg);
  color: var(--danger);
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-input,
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 8px;
  font: inherit;
  background: var(--surface);
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-textarea {
  resize: vertical;
  font-size: 12px;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
[${TLS_CERTS_PANEL_ATTR}] .tls-certs-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
@media (max-width: 560px) {
  [${TLS_CERTS_PANEL_ATTR}] .tls-certs-row-meta {
    grid-template-columns: minmax(0, 1fr);
  }
}
` + '\n' + CERTIFICATES_WORKSPACE_STYLES;
