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

  const wrapper = doc.createElement('div');
  wrapper.setAttribute(TLS_CERTS_PANEL_ATTR, '');
  wrapper.className = 'tls-certs-panel';
  opts.host.appendChild(wrapper);

  const clearChildren = (el: HTMLElement): void => {
    while (el.firstChild) el.removeChild(el.firstChild);
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
    btn.disabled = disabled;
    btn.addEventListener('click', onClick);
    return btn;
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
    area.className = 'tls-certs-textarea tls-certs-mono';
    area.rows = 5;
    area.placeholder = placeholder;
    area.value = state.upload.values[field];
    area.setAttribute(TLS_CERTS_UPLOAD_FIELD_ATTR, field);
    area.addEventListener('input', () => onInput(area.value));
    label.appendChild(area);
    wrap.appendChild(label);

    const file = doc.createElement('input');
    file.type = 'file';
    file.className = 'tls-certs-file';
    file.setAttribute(TLS_CERTS_UPLOAD_FILE_ATTR, field);
    file.addEventListener('change', () => {
      const picked = (file as { files?: { length: number; [i: number]: unknown } | null }).files;
      const first = picked && picked.length > 0 ? picked[0] : null;
      if (first === null || first === undefined) return;
      const ReaderCtor = (globalThis as { FileReader?: typeof FileReader }).FileReader;
      if (ReaderCtor === undefined) return;
      const reader = new ReaderCtor();
      reader.addEventListener('load', () => {
        if (disposed) return;
        const text = typeof reader.result === 'string' ? reader.result : '';
        if (text === '') return;
        // Route through the same setter the textarea uses so the state
        // update, the error clear and the re-render are identical either way.
        handle.setUploadField(field, text);
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
      wrapper.appendChild(
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
      actions.appendChild(
        makeButton('Replace', TLS_CERTS_UPLOAD_OPEN_BTN_ATTR, 'secondary', () => {
          handle.openUpload(row.domain);
        }, false, row.domain),
      );
      if (opts.runRemove !== undefined) {
        actions.appendChild(
          makeButton('Remove', TLS_CERTS_REMOVE_OPEN_BTN_ATTR, 'danger', () => {
            handle.openRemove(row.domain);
          }, false, row.domain),
        );
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
        confirmActions.appendChild(
          makeButton('Cancel', TLS_CERTS_REMOVE_CANCEL_BTN_ATTR, 'secondary', () => {
            handle.cancelRemove();
          }, state.remove.saving),
        );
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
    wrapper.appendChild(list);
  };

  const renderUploadForm = (): void => {
    if (!state.upload.open) return;
    const form = doc.createElement('div');
    form.className = 'tls-certs-form';
    form.setAttribute(TLS_CERTS_UPLOAD_FORM_ATTR, '');

    form.appendChild(
      makeNote(
        'Paste the PEM blocks, or pick the files. The private key is encrypted at rest on this server and is never sent to the cloud.',
        'tls-certs-muted',
      ),
    );

    if (state.upload.error !== null) {
      form.appendChild(
        makeNote(state.upload.error, 'tls-certs-error', TLS_CERTS_ERROR_ATTR),
      );
    }
    for (const issue of state.upload.issues) {
      const p = makeNote(issue.copy, 'tls-certs-issue');
      p.setAttribute(TLS_CERTS_ISSUE_ATTR, issue.code);
      form.appendChild(p);
    }

    const domainWrap = doc.createElement('div');
    domainWrap.className = 'tls-certs-field';
    const domainLabel = doc.createElement('label');
    const domainSpan = doc.createElement('span');
    domainSpan.className = 'tls-certs-field-label';
    domainSpan.textContent = 'Hostname';
    domainLabel.appendChild(domainSpan);
    const domainInput = doc.createElement('input');
    domainInput.type = 'text';
    domainInput.className = 'tls-certs-input';
    domainInput.placeholder = 'server.example.com';
    domainInput.value = state.upload.values.domain;
    domainInput.setAttribute(TLS_CERTS_UPLOAD_FIELD_ATTR, 'domain');
    domainInput.addEventListener('input', () => {
      handle.setUploadField('domain', domainInput.value);
    });
    domainLabel.appendChild(domainInput);
    domainWrap.appendChild(domainLabel);
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
    actions.appendChild(
      makeButton('Cancel', TLS_CERTS_UPLOAD_CANCEL_BTN_ATTR, 'secondary', () => {
        handle.cancelUpload();
      }, state.upload.saving),
    );
    actions.appendChild(
      makeButton(
        state.upload.saving ? 'Uploading…' : 'Upload certificate',
        TLS_CERTS_UPLOAD_SUBMIT_BTN_ATTR,
        'primary',
        () => {
          void handle.submitUpload();
        },
        state.upload.saving,
      ),
    );
    form.appendChild(actions);
    wrapper.appendChild(form);
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren(wrapper);

    const heading = doc.createElement('h4');
    heading.className = 'tls-certs-title';
    heading.textContent = 'Installed certificates';
    wrapper.appendChild(heading);

    if (state.loading) {
      wrapper.appendChild(
        makeNote('Loading certificates…', 'tls-certs-muted', TLS_CERTS_STATUS_ATTR),
      );
      return;
    }
    if (state.error !== null) {
      wrapper.appendChild(
        makeNote(state.error, 'tls-certs-error', TLS_CERTS_ERROR_ATTR),
      );
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
      block.appendChild(makeNote('Certificate installed.', 'tls-certs-ok'));
      block.appendChild(meta);
      wrapper.appendChild(block);
    }

    renderRows();
    renderUploadForm();

    if (!state.upload.open) {
      const actions = doc.createElement('div');
      actions.className = 'tls-certs-actions';
      actions.appendChild(
        makeButton('Upload a certificate', TLS_CERTS_UPLOAD_OPEN_BTN_ATTR, 'primary', () => {
          handle.openUpload();
        }),
      );
      wrapper.appendChild(actions);
    }
  };

  const load = (): Promise<void> => {
    const gen = ++loadGeneration;
    state = { ...state, loading: true, error: null };
    render();
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
      render();
    })();
    return pendingLoad;
  };

  const handle: TlsCertificatesPanelMount = {
    getState: () => state,
    refresh: () => load(),
    whenLoaded: () => pendingLoad,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    },

    openUpload: (domain) => {
      if (disposed) return;
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
      state = {
        ...state,
        upload: {
          ...state.upload,
          error: null,
          issues: [],
          values: { ...state.upload.values, [field]: value },
        },
      };
      render();
    },

    submitUpload: async () => {
      if (disposed || state.upload.saving) return;
      const values = state.upload.values;
      const domain = values.domain.trim();
      const cert_pem = values.cert_pem.trim();
      const private_key_pem = values.private_key_pem.trim();
      const chain_pem = values.chain_pem.trim();

      // Cheap shape checks only. The AUTHORITATIVE parse is server-side
      // (`node:crypto` X509 + the SAN / key-pair / chain / expiry gates); this
      // exists so an empty or obviously-not-PEM paste gets an answer without a
      // round trip, not to duplicate the validator.
      const complaint =
        domain === ''
          ? 'You need to give a name.'
          : !cert_pem.includes('-----BEGIN ')
            ? 'Certificate must be a PEM block beginning with "-----BEGIN CERTIFICATE-----".'
            : !private_key_pem.includes('-----BEGIN ')
              ? 'Private key must be a PEM block beginning with "-----BEGIN".'
              : chain_pem !== '' && !chain_pem.includes('-----BEGIN ')
                ? 'Issuer chain must be a PEM block when provided.'
                : null;
      if (complaint !== null) {
        state = { ...state, upload: { ...state.upload, error: complaint, issues: [] } };
        render();
        return;
      }

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
        if (disposed) return;
        state = {
          ...state,
          upload: {
            open: false,
            saving: false,
            error: null,
            issues: [],
            result,
            // Drop the pasted key from client state the moment the server has
            // it. Nothing re-reads these after a success, and a private key
            // that lingers in a closure is a private key that can be read out
            // of a heap snapshot.
            values: { ...EMPTY_UPLOAD_VALUES },
          },
        };
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
        if (disposed) return;
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
      if (disposed) return;
      state = { ...state, remove: { domain, saving: false, error: null } };
      render();
    },

    cancelRemove: () => {
      if (disposed) return;
      state = { ...state, remove: { domain: null, saving: false, error: null } };
      render();
    },

    confirmRemove: async () => {
      if (disposed || state.remove.saving) return;
      const domain = state.remove.domain;
      const runRemove = opts.runRemove;
      if (domain === null || runRemove === undefined) return;
      state = { ...state, remove: { ...state.remove, saving: true, error: null } };
      render();
      try {
        await runRemove({ domain });
        if (disposed) return;
        state = {
          ...state,
          remove: { domain: null, saving: false, error: null },
          upload: { ...state.upload, result: null },
        };
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

  void load();
  return handle;
};

export const TLS_CERTIFICATES_PANEL_STYLES = `
[${TLS_CERTS_PANEL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 13px;
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
`;
