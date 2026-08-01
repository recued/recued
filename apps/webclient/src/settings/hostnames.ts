/** D-152 P6 - Settings -> Server hostnames panel.
 *
 * First webclient consumer for the D-152 `collection.hostname.*` RPC
 * surface. The panel now covers the full local CRUD loop: list/add/get detail,
 * update, remove, and drive `verifyOwnership`.
 */

import type {
  DdnsEnabledStatus,
  DdnsSetEnabledRequest,
  DiagnosticResponse,
  HostnameAddRequest,
  HostnameCertSource,
  HostnameGetRequest,
  HostnameGetResponse,
  HostnameListResponse,
  HostnameMutationResponse,
  HostnameOwnershipProofInput,
  HostnameOwnershipProofResult,
  HostnameOwnershipStatus,
  HostnameProjection,
  HostnameRemoveRequest,
  HostnameRemoveResponse,
  HostnameUpdateRequest,
  HostnameVerificationMethod,
  LocalServerUrl,
  NetworkLocalUrlsResponse,
} from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';
import type { ReachabilityExternalProbeCaller } from './reachability.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ---------------------------------------------------------------------------
// Stable DOM hooks
// ---------------------------------------------------------------------------

export const HOSTNAMES_PANEL_ATTR = 'data-recued-hostnames-panel';
export const HOSTNAMES_PANEL_STATUS_ATTR = 'data-recued-hostnames-status';
export const HOSTNAMES_PANEL_ERROR_ATTR = 'data-recued-hostnames-error';
export const HOSTNAMES_PANEL_EMPTY_ATTR = 'data-recued-hostnames-empty';
export const HOSTNAMES_ROW_ATTR = 'data-recued-hostnames-row';
export const HOSTNAMES_ROW_STATUS_ATTR = 'data-recued-hostnames-row-status';
// R26.4 Delta 4 — the cert-expiry chip's attr value carries the severity
// (`ok` / `warning` / `expired`) so the at-a-glance signal is testable +
// the host can introspect cert health without parsing copy.
export const HOSTNAMES_ROW_CERT_EXPIRY_ATTR = 'data-recued-hostnames-row-cert-expiry';
export const HOSTNAMES_ADD_OPEN_BTN_ATTR = 'data-recued-hostnames-add-open';
export const HOSTNAMES_ADD_FORM_ATTR = 'data-recued-hostnames-add-form';
export const HOSTNAMES_ADD_FIELD_ATTR = 'data-recued-hostnames-add-field';
export const HOSTNAMES_ADD_SUBMIT_BTN_ATTR = 'data-recued-hostnames-add-submit';
export const HOSTNAMES_ADD_CANCEL_BTN_ATTR = 'data-recued-hostnames-add-cancel';
export const HOSTNAMES_VERIFY_OPEN_BTN_ATTR = 'data-recued-hostnames-verify-open';
export const HOSTNAMES_VERIFY_FORM_ATTR = 'data-recued-hostnames-verify-form';
export const HOSTNAMES_VERIFY_FIELD_ATTR = 'data-recued-hostnames-verify-field';
export const HOSTNAMES_VERIFY_SUBMIT_BTN_ATTR =
  'data-recued-hostnames-verify-submit';
export const HOSTNAMES_VERIFY_AUTO_PROBE_STATUS_ATTR =
  'data-recued-hostnames-verify-auto-probe-status';
export const HOSTNAMES_VERIFY_CANCEL_BTN_ATTR =
  'data-recued-hostnames-verify-cancel';
export const HOSTNAMES_DETAIL_OPEN_BTN_ATTR = 'data-recued-hostnames-detail-open';
export const HOSTNAMES_DETAIL_PANEL_ATTR = 'data-recued-hostnames-detail';
export const HOSTNAMES_DETAIL_CLOSE_BTN_ATTR =
  'data-recued-hostnames-detail-close';
export const HOSTNAMES_UPDATE_OPEN_BTN_ATTR = 'data-recued-hostnames-update-open';
export const HOSTNAMES_UPDATE_FORM_ATTR = 'data-recued-hostnames-update-form';
export const HOSTNAMES_UPDATE_FIELD_ATTR = 'data-recued-hostnames-update-field';
export const HOSTNAMES_UPDATE_SUBMIT_BTN_ATTR =
  'data-recued-hostnames-update-submit';
export const HOSTNAMES_UPDATE_CANCEL_BTN_ATTR =
  'data-recued-hostnames-update-cancel';
export const HOSTNAMES_REMOVE_OPEN_BTN_ATTR = 'data-recued-hostnames-remove-open';
export const HOSTNAMES_REMOVE_CONFIRM_PANEL_ATTR =
  'data-recued-hostnames-remove-confirm-panel';
export const HOSTNAMES_REMOVE_CONFIRM_BTN_ATTR =
  'data-recued-hostnames-remove-confirm';
export const HOSTNAMES_REMOVE_CANCEL_BTN_ATTR =
  'data-recued-hostnames-remove-cancel';
// LAN-URL kickstart (slice 2) — the read-only "Reachable on your network"
// section listing the loopback + LAN addresses the server binds locally. The
// row attr carries the URL (test lookup by address); the kind attr carries
// `loopback` / `lan` so the at-a-glance chip is testable.
export const HOSTNAMES_LOCAL_URLS_ATTR = 'data-recued-hostnames-local-urls';
export const HOSTNAMES_LOCAL_URL_ROW_ATTR = 'data-recued-hostnames-local-url';
export const HOSTNAMES_LOCAL_URL_KIND_ATTR =
  'data-recued-hostnames-local-url-kind';
// R27 delta-B — Pro DDNS pause/resume control (the `<handle>.recued.net`
// publication toggle).
export const HOSTNAMES_DDNS_SECTION_ATTR = 'data-recued-hostnames-ddns';
export const HOSTNAMES_DDNS_STATE_ATTR = 'data-recued-hostnames-ddns-state';
export const HOSTNAMES_DDNS_TOGGLE_ATTR = 'data-recued-hostnames-ddns-toggle';
export const HOSTNAMES_DDNS_BLOCKED_ATTR = 'data-recued-hostnames-ddns-blocked';
export const HOSTNAMES_DDNS_ERROR_ATTR = 'data-recued-hostnames-ddns-error';

const LOCAL_URL_KIND_LABELS: Record<LocalServerUrl['kind'], string> = {
  loopback: 'This device',
  lan: 'LAN',
};

const CERT_SOURCE_LABELS: Record<HostnameCertSource, string> = {
  recued_acme: 'Managed by Recued',
  byo_uploaded: 'Upload my own certificate',
  byo_external: 'Handled outside Recued',
};

const VERIFICATION_METHOD_LABELS: Record<HostnameVerificationMethod, string> = {
  cert_proof: 'Certificate proof',
  http_token: 'HTTP token',
  dns_txt: 'DNS TXT',
};

const OWNERSHIP_LABELS: Record<HostnameOwnershipStatus, string> = {
  pending: 'Pending',
  verified: 'Verified',
  failed: 'Failed',
};

const OWNERSHIP_CLASS: Record<HostnameOwnershipStatus, string> = {
  pending: 'hostnames-pill-pending',
  verified: 'hostnames-pill-verified',
  failed: 'hostnames-pill-failed',
};

export const HOSTNAMES_PANEL_STYLES = `
[${HOSTNAMES_PANEL_ATTR}] {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--surface);
}
.hostnames-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.hostnames-panel-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.hostnames-panel-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hostnames-row {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--surface);
}
.hostnames-row-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.hostnames-row-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.hostnames-row-meta,
.hostnames-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.hostnames-meta-label,
.hostnames-field-label {
  display: block;
  color: var(--muted-fg);
  font-size: 11px;
  margin-bottom: 3px;
}
.hostnames-meta-value {
  overflow-wrap: anywhere;
}
.hostnames-pill {
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
}
.hostnames-pill-pending {
  background: var(--warn-bg);
  color: var(--warn);
}
.hostnames-pill-verified {
  background: var(--ok-bg);
  color: var(--ok-fg);
}
.hostnames-pill-failed {
  background: var(--danger-bg);
  color: var(--danger);
}
.hostnames-cert-chip {
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
}
.hostnames-cert-chip-ok {
  background: var(--ok-bg);
  color: var(--ok-fg);
}
.hostnames-cert-chip-warning {
  background: var(--warn-bg);
  color: var(--warn);
}
.hostnames-cert-chip-expired {
  background: var(--danger-bg);
  color: var(--danger);
}
.hostnames-form,
.hostnames-verify-form,
.hostnames-detail-panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--surface);
}
.hostnames-input,
.hostnames-select {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 8px;
  font: inherit;
  background: var(--surface);
}
.hostnames-checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hostnames-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.hostnames-error {
  border-radius: 6px;
  background: var(--danger-bg);
  color: var(--danger);
  padding: 8px;
}
.hostnames-detail-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.hostnames-muted {
  color: var(--muted-fg);
}
.hostnames-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.hostnames-local-urls,
.hostnames-ddns {
  border-top: 1px solid var(--border);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hostnames-ddns {
  align-items: flex-start;
}
.hostnames-local-urls-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.hostnames-local-urls-desc {
  margin: 0;
}
.hostnames-local-url-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
}
.hostnames-local-url-value {
  overflow-wrap: anywhere;
  user-select: all;
}
.hostnames-local-url-kind-loopback {
  background: var(--surface);
  color: var(--muted-fg);
  border: 1px solid var(--border);
}
.hostnames-local-url-kind-lan {
  background: var(--ok-bg);
  color: var(--ok-fg);
}
@media (max-width: 640px) {
  .hostnames-panel-header,
  .hostnames-row-main {
    align-items: stretch;
    flex-direction: column;
  }
  .hostnames-row-meta,
  .hostnames-form-grid {
    grid-template-columns: 1fr;
  }
}
`;

// ---------------------------------------------------------------------------
// Caller seams and state
// ---------------------------------------------------------------------------

export type HostnamesListCaller = () => Promise<HostnameListResponse>;
export type HostnamesGetCaller = (
  input: HostnameGetRequest,
) => Promise<HostnameGetResponse>;
export type HostnamesAddCaller = (
  input: HostnameAddRequest,
) => Promise<HostnameMutationResponse>;
export type HostnamesUpdateCaller = (
  input: HostnameUpdateRequest,
) => Promise<HostnameMutationResponse>;
export type HostnamesRemoveCaller = (
  input: HostnameRemoveRequest,
) => Promise<HostnameRemoveResponse>;
export type HostnamesVerifyOwnershipCaller = (
  input: HostnameOwnershipProofInput,
) => Promise<HostnameOwnershipProofResult>;
/** LAN-URL kickstart (slice 2) — `network.local_urls` caller. Returns the
 *  loopback + LAN addresses the server binds locally, for the read-only
 *  "Reachable on your network" section. Optional: absent → the section is
 *  not rendered. */
export type NetworkLocalUrlsCaller = () => Promise<NetworkLocalUrlsResponse>;

/** R27 delta-B — Pro DDNS pause/resume control seams. */
export type DdnsStatusCaller = () => Promise<DdnsEnabledStatus>;
export type DdnsSetEnabledCaller = (
  input: DdnsSetEnabledRequest,
) => Promise<DdnsEnabledStatus>;

/** Cross-domain gate context for the Pro DDNS toggle, composed by the settings
 *  route (which holds the pro-convenience caller + the local store):
 *    - `published` — DDNS is actually live (`pro_convenience.status.items.ddns
 *      === 'active'`). The toggle is OFFERED only when true, so a pause can
 *      never be issued before a cloud record exists (Slice-1 no-row case).
 *    - `ddnsHostname` — the `<handle>.recued.net` FQDN (for the guard message).
 *    - `blockToggle` — the self-disconnect guard: BLOCK the toggle (don't offer
 *      pause) when this webclient reaches its server VIA that FQDN — OR when we
 *      cannot PROVE it doesn't (unreadable/unparseable `server_url`, missing
 *      hostname). Fail-CLOSED: an unprovable case blocks, so a user can never
 *      cut the connection issuing the pause. */
export interface DdnsControlContext {
  published: boolean;
  ddnsHostname: string | null;
  blockToggle: boolean;
}

export type DdnsControlContextCaller = () => Promise<DdnsControlContext>;

/** Normalize a DNS host for comparison: trim, lower-case, strip the trailing
 *  root dot(s) (`alice.recued.net.` ≡ `alice.recued.net`). Null for empty. */
const normalizeDnsHost = (host: string | null | undefined): string | null => {
  if (typeof host !== 'string') return null;
  const trimmed = host.trim().toLowerCase().replace(/\.+$/, '');
  return trimmed.length > 0 ? trimmed : null;
};

/** Pure self-disconnect guard (R27 delta-B): should the Pro DDNS pause toggle be
 *  BLOCKED? TRUE when this client is — or might be — connected to its server via
 *  the Pro DDNS handle: the dialed `server_url` host equals `<handle>.recued.net`
 *  (normalized), OR we cannot PROVE it differs (unreadable/unparseable
 *  `server_url`, or a missing hostname). FAILS CLOSED — an unprovable case
 *  blocks the toggle, so a user can never sever the connection issuing the pause.
 *  Exported for the route + unit tests. */
export const ddnsPauseWouldSelfDisconnect = (
  serverUrl: string | null | undefined,
  ddnsHostname: string | null | undefined,
): boolean => {
  const handle = normalizeDnsHost(ddnsHostname);
  if (handle === null) return true; // no hostname to compare → block
  if (!serverUrl) return true; // can't read the dialed host → block
  let dialed: string | null;
  try {
    dialed = normalizeDnsHost(new URL(serverUrl).hostname);
  } catch {
    return true; // unparseable server_url → block
  }
  if (dialed === null) return true; // empty host → block
  return dialed === handle; // block iff the dialed host IS the handle
};

type AddValues = {
  hostname: string;
  cert_source: HostnameCertSource;
  verification_method: HostnameVerificationMethod;
  verification_token_hash: string;
  enabled: boolean;
};

type UpdateValues = {
  cert_source: HostnameCertSource;
  verification_method: HostnameVerificationMethod;
  verification_token_hash: string;
  enabled: boolean;
};

type DetailValues = {
  hostname: string | null;
  loading: boolean;
  error: string | null;
  projection: HostnameProjection | null;
};

type RemoveValues = {
  hostname: string | null;
  saving: boolean;
  error: string | null;
};

type VerifyValues = {
  hostname: string | null;
  method: HostnameVerificationMethod;
  observed_token_hash: string;
  cert_matches_hostname: boolean;
  saving: boolean;
  error: string | null;
  result: HostnameOwnershipProofResult | null;
};

export interface HostnamesPanelState {
  loading: boolean;
  error: string | null;
  hostnames: HostnameProjection[];
  /** LAN-URL kickstart (slice 2) — loopback + LAN URLs the server binds
   *  locally. Empty when no `runLocalUrls` caller is supplied, the call is
   *  still in flight, or it failed (the section renders only when non-empty). */
  localUrls: LocalServerUrl[];
  add: {
    open: boolean;
    saving: boolean;
    error: string | null;
    values: AddValues;
  };
  update: {
    hostname: string | null;
    saving: boolean;
    error: string | null;
    values: UpdateValues;
  };
  detail: DetailValues;
  remove: RemoveValues;
  verify: VerifyValues;
  /** R27 delta-B — Pro DDNS pause/resume control. `available` gates rendering
   *  (the ddns callers are wired AND DDNS is published); `blockToggle` blocks
   *  the toggle (self-disconnect guard, fail-closed). */
  ddns: {
    available: boolean;
    enabled: boolean;
    blockToggle: boolean;
    hostname: string | null;
    busy: boolean;
    error: string | null;
  };
}

export interface MountHostnamesPanelOptions {
  host: HTMLElement;
  document?: Document;
  runList: HostnamesListCaller;
  runGet: HostnamesGetCaller;
  runAdd: HostnamesAddCaller;
  runUpdate: HostnamesUpdateCaller;
  runRemove: HostnamesRemoveCaller;
  runVerifyOwnership: HostnamesVerifyOwnershipCaller;
  runExternalProbe?: ReachabilityExternalProbeCaller;
  /** LAN-URL kickstart (slice 2) — when supplied, the panel fetches the
   *  server's loopback + LAN URLs and renders the read-only "Reachable on
   *  your network" section. Fetched separately from the hostname list so a
   *  slow/failing call never blocks the registry rows; absent → no section. */
  runLocalUrls?: NetworkLocalUrlsCaller;
  /** R27 delta-B — Pro DDNS pause/resume control. All three are wired together
   *  by the settings route (which composes `runDdnsControlContext` from the
   *  pro-convenience caller + the local store); absent → no Pro DDNS section. */
  runDdnsStatus?: DdnsStatusCaller;
  runDdnsSetEnabled?: DdnsSetEnabledCaller;
  runDdnsControlContext?: DdnsControlContextCaller;
  /** R26.4 Delta 4 — `Date.now`-compatible clock for the cert-expiry
   *  chip's relative copy + near-expiry severity. Defaults to `Date.now`;
   *  tests pin it so "expires in N days" is reproducible. */
  now?: () => number;
}

export interface HostnamesPanelMount {
  getState(): HostnamesPanelState;
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  dispose(): void;
  openAdd(): void;
  cancelAdd(): void;
  setAddField(field: keyof AddValues, value: string | boolean): void;
  submitAdd(): Promise<void>;
  openDetail(hostname: string): Promise<void>;
  closeDetail(): void;
  openUpdate(hostname: string): void;
  cancelUpdate(): void;
  setUpdateField(field: keyof UpdateValues, value: string | boolean): void;
  submitUpdate(): Promise<void>;
  openRemove(hostname: string): void;
  cancelRemove(): void;
  confirmRemove(): Promise<void>;
  openVerify(hostname: string): void;
  cancelVerify(): void;
  setVerifyField(field: keyof Pick<
    VerifyValues,
    'method' | 'observed_token_hash' | 'cert_matches_hostname'
  >, value: string | boolean): void;
  submitVerify(): Promise<void>;
}

const DEFAULT_ADD_VALUES: AddValues = {
  hostname: '',
  cert_source: 'byo_external',
  verification_method: 'dns_txt',
  verification_token_hash: '',
  enabled: true,
};

const DEFAULT_UPDATE_VALUES: UpdateValues = {
  cert_source: 'byo_external',
  verification_method: 'dns_txt',
  verification_token_hash: '',
  enabled: true,
};

const DEFAULT_DETAIL_VALUES: DetailValues = {
  hostname: null,
  loading: false,
  error: null,
  projection: null,
};

const DEFAULT_REMOVE_VALUES: RemoveValues = {
  hostname: null,
  saving: false,
  error: null,
};

const DEFAULT_VERIFY_VALUES: VerifyValues = {
  hostname: null,
  method: 'dns_txt',
  observed_token_hash: '',
  cert_matches_hostname: false,
  saving: false,
  error: null,
  result: null,
};

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

const compatibleMethodsFor = (
  certSource: HostnameCertSource,
): HostnameVerificationMethod[] => {
  if (certSource === 'recued_acme') return [];
  if (certSource === 'byo_external') return ['dns_txt', 'http_token'];
  return ['cert_proof', 'dns_txt', 'http_token'];
};

const defaultMethodFor = (certSource: HostnameCertSource): HostnameVerificationMethod =>
  compatibleMethodsFor(certSource)[0] ?? 'dns_txt';

const upsertProjection = (
  rows: HostnameProjection[],
  next: HostnameProjection,
): HostnameProjection[] => {
  const idx = rows.findIndex((r) => r.hostname === next.hostname);
  if (idx < 0) return [...rows, next];
  const out = rows.slice();
  out[idx] = next;
  return out;
};

const removeProjection = (
  rows: HostnameProjection[],
  hostname: string,
): HostnameProjection[] => rows.filter((r) => r.hostname !== hostname);

const shortFingerprint = (fp: string | undefined): string => {
  if (!fp) return 'none';
  if (fp.length <= 16) return fp;
  return `${fp.slice(0, 10)}...${fp.slice(-6)}`;
};

const formatDate = (value: number | undefined): string => {
  if (value === undefined) return 'none';
  return formatClientDateTime(value, { invalidText: 'unknown' });
};

// R26.4 Delta 4 — cert-expiry "near expiry" threshold. Mirrors the
// backend's `HOSTNAME_CERT_RENEWAL_MONITORING_WINDOW_MS`
// (`backend/server/src/hostname/reconciliation-jobs.ts`, 14 days) so the
// UI turns amber on exactly the window the server starts requesting a
// renewal — the operator sees the warning before the auto-renewal fires.
const CERT_EXPIRY_WARNING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CertExpirySeverity = 'none' | 'ok' | 'warning' | 'expired';

export interface CertExpiryDisplay {
  /** `none` when there is no cert (or a malformed timestamp) — the chip is
   *  not rendered. `expired` past the date; `warning` within the renewal
   *  window; `ok` otherwise. */
  severity: CertExpirySeverity;
  /** Short relative copy for the chip, e.g. "expires in 12 days" /
   *  "expired". */
  text: string;
}

/** Project a cert `expires_at` (unix-ms) into the at-a-glance chip
 *  display. `now` is injected so the relative copy is deterministic in
 *  tests. */
export const formatCertExpiry = (
  expires_at: number | undefined,
  now: number,
): CertExpiryDisplay => {
  if (expires_at === undefined || expires_at === 0) return { severity: 'none', text: '' };
  if (!Number.isFinite(expires_at)) return { severity: 'none', text: '' };
  const diff = expires_at - now;
  if (diff <= 0) return { severity: 'expired', text: 'cert expired' };
  const days = Math.ceil(diff / DAY_MS);
  const rel =
    days <= 1
      ? 'expires within a day'
      : days < 60
        ? `expires in ${days} days`
        : `expires in ${Math.round(days / 30)} months`;
  return {
    // Strict `<` so the amber threshold matches the backend renewal
    // trigger EXACTLY (Codex P1 fold): the reconciliation monitor renews
    // when `cert_expires_at - now < WINDOW` (it skips at `>=`), so the UI
    // must warn on the same open interval — at exactly the window, neither
    // fires yet.
    severity: diff < CERT_EXPIRY_WARNING_WINDOW_MS ? 'warning' : 'ok',
    text: rel,
  };
};

const proofFailureCopy = (result: Exclude<HostnameOwnershipProofResult, { ok: true }>): string => {
  if (result.code === 'method_mismatch' && result.expected_method !== undefined) {
    return `Expected ${VERIFICATION_METHOD_LABELS[result.expected_method]}.`;
  }
  if (result.code === 'recued_acme_preverified') return 'Recued ACME hostnames are already verified.';
  if (result.code === 'missing_token_hash') return 'This hostname does not have a token hash saved.';
  if (result.code === 'incompatible_proof_method') return 'Proof method is not compatible with this cert source.';
  if (result.code === 'not_found') return 'Hostname not found.';
  if (result.code === 'invalid_hostname') return 'Hostname is invalid.';
  return result.code;
};

const updateValuesFor = (row: HostnameProjection): UpdateValues => ({
  cert_source: row.cert_source,
  verification_method: row.verification_method ?? defaultMethodFor(row.cert_source),
  verification_token_hash: '',
  enabled: row.enabled,
});

const diagnosticResponseHasHostnameMatchedTls = (
  response: DiagnosticResponse,
): boolean =>
  response.results.some((result) =>
    result.kind === 'tls_handshake'
    && result.status === 'pass'
    && result.payload.kind === 'tls_handshake'
    && result.payload.cert_valid
    && result.payload.cert_matches_hostname,
  );

const buildAutoVerifyRequest = (
  row: HostnameProjection,
  method: HostnameVerificationMethod,
  response: DiagnosticResponse,
): HostnameOwnershipProofInput | null => {
  if (response.hostname !== row.hostname) return null;
  if (method === 'cert_proof') {
    return {
      hostname: row.hostname,
      method: 'cert_proof',
      cert_matches_hostname: diagnosticResponseHasHostnameMatchedTls(response),
    };
  }
  const observed = response.observed_token_hash?.trim();
  if (observed === undefined || observed.length === 0) return null;
  return {
    hostname: row.hostname,
    method,
    observed_token_hash: observed,
  };
};

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export const mountHostnamesPanel = (
  opts: MountHostnamesPanelOptions,
): HostnamesPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountHostnamesPanel: no document available - pass `opts.document` for non-browser environments',
    );
  }
  // R26.4 Delta 4 — clock for the cert-expiry chip's relative copy.
  const now = opts.now ?? Date.now;

  let state: HostnamesPanelState = {
    loading: true,
    error: null,
    hostnames: [],
    localUrls: [],
    add: {
      open: false,
      saving: false,
      error: null,
      values: { ...DEFAULT_ADD_VALUES },
    },
    update: {
      hostname: null,
      saving: false,
      error: null,
      values: { ...DEFAULT_UPDATE_VALUES },
    },
    detail: { ...DEFAULT_DETAIL_VALUES },
    remove: { ...DEFAULT_REMOVE_VALUES },
    verify: { ...DEFAULT_VERIFY_VALUES },
    ddns: {
      available: false,
      enabled: true,
      blockToggle: true,
      hostname: null,
      busy: false,
      error: null,
    },
  };
  let disposed = false;
  let loadGeneration = 0;
  let detailGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();

  const wrapper = doc.createElement('div');
  wrapper.setAttribute(HOSTNAMES_PANEL_ATTR, '');
  wrapper.className = 'hostnames-panel';
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
  ): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `rx-btn rx-btn-${variant} rx-btn-sm`;
    btn.textContent = label;
    btn.setAttribute(attr, '');
    btn.disabled = disabled;
    btn.addEventListener('click', onClick);
    return btn;
  };

  const makeField = (
    labelText: string,
    child: HTMLElement,
  ): HTMLLabelElement => {
    const label = doc.createElement('label');
    const span = doc.createElement('span');
    span.className = 'hostnames-field-label';
    span.textContent = labelText;
    label.appendChild(span);
    label.appendChild(child);
    return label;
  };

  const makeInput = (
    field: string,
    value: string,
    onInput: (value: string) => void,
    attr = HOSTNAMES_ADD_FIELD_ATTR,
    mono = false,
  ): HTMLInputElement => {
    const input = doc.createElement('input');
    input.className = mono ? 'hostnames-input hostnames-mono' : 'hostnames-input';
    input.type = 'text';
    input.value = value;
    input.setAttribute(attr, field);
    input.addEventListener('input', () => onInput(input.value));
    return input;
  };

  const makeVerifyInput = (
    field: string,
    value: string,
    onInput: (value: string) => void,
  ): HTMLInputElement => {
    const input = doc.createElement('input');
    input.className = 'hostnames-input hostnames-mono';
    input.type = 'text';
    input.value = value;
    input.setAttribute(HOSTNAMES_VERIFY_FIELD_ATTR, field);
    input.addEventListener('input', () => onInput(input.value));
    return input;
  };

  const makeCertSourceSelect = (
    attr: string,
    value: HostnameCertSource,
    onChange: (value: HostnameCertSource) => void,
  ): HTMLSelectElement => {
    const select = doc.createElement('select');
    select.className = 'hostnames-select';
    select.setAttribute(attr, 'cert_source');
    for (const source of ['byo_external', 'byo_uploaded', 'recued_acme'] as const) {
      const option = doc.createElement('option');
      option.value = source;
      option.textContent = CERT_SOURCE_LABELS[source];
      select.appendChild(option);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value as HostnameCertSource));
    return select;
  };

  const makeAddCertSourceSelect = (): HTMLSelectElement =>
    makeCertSourceSelect(HOSTNAMES_ADD_FIELD_ATTR, state.add.values.cert_source, (cert_source) => {
      state = {
        ...state,
        add: {
          ...state.add,
          error: null,
          values: {
            ...state.add.values,
            cert_source,
            verification_method: defaultMethodFor(cert_source),
            verification_token_hash:
              cert_source === 'recued_acme' ? '' : state.add.values.verification_token_hash,
          },
        },
      };
      render();
    });

  const makeUpdateCertSourceSelect = (): HTMLSelectElement => {
    const current = state.update.values.cert_source;
    return makeCertSourceSelect(HOSTNAMES_UPDATE_FIELD_ATTR, current, (cert_source) => {
      state = {
        ...state,
        update: {
          ...state.update,
          error: null,
          values: {
            ...state.update.values,
            cert_source,
            verification_method: defaultMethodFor(cert_source),
            verification_token_hash:
              cert_source === 'recued_acme' ? '' : state.update.values.verification_token_hash,
          },
        },
      };
      render();
    });
  };

  const makeMethodSelect = (
    attr: string,
    methods: HostnameVerificationMethod[],
    value: HostnameVerificationMethod,
    onChange: (value: HostnameVerificationMethod) => void,
  ): HTMLSelectElement => {
    const select = doc.createElement('select');
    select.className = 'hostnames-select';
    select.setAttribute(attr, 'method');
    for (const method of methods) {
      const option = doc.createElement('option');
      option.value = method;
      option.textContent = VERIFICATION_METHOD_LABELS[method];
      select.appendChild(option);
    }
    select.value = methods.includes(value) ? value : methods[0] ?? 'dns_txt';
    select.addEventListener('change', () => onChange(select.value as HostnameVerificationMethod));
    return select;
  };

  const renderError = (message: string, attr = HOSTNAMES_PANEL_ERROR_ATTR): HTMLParagraphElement => {
    const p = doc.createElement('p');
    p.className = 'hostnames-error';
    p.setAttribute(attr, '');
    p.setAttribute('role', 'alert');
    p.textContent = message;
    return p;
  };

  const renderAddForm = (): void => {
    if (!state.add.open) return;
    const form = doc.createElement('div');
    form.className = 'hostnames-form';
    form.setAttribute(HOSTNAMES_ADD_FORM_ATTR, '');

    if (state.add.error !== null) form.appendChild(renderError(state.add.error));

    const grid = doc.createElement('div');
    grid.className = 'hostnames-form-grid';
    grid.appendChild(
      makeField(
        'Hostname',
        makeInput('hostname', state.add.values.hostname, (hostname) => {
          state = {
            ...state,
            add: {
              ...state.add,
              error: null,
              values: { ...state.add.values, hostname },
            },
          };
        }),
      ),
    );
    grid.appendChild(makeField('Cert source', makeAddCertSourceSelect()));

    const methods = compatibleMethodsFor(state.add.values.cert_source);
    if (methods.length > 0) {
      grid.appendChild(
        makeField(
          'Proof method',
          makeMethodSelect(
            HOSTNAMES_ADD_FIELD_ATTR,
            methods,
            state.add.values.verification_method,
            (verification_method) => {
              state = {
                ...state,
                add: {
                  ...state.add,
                  error: null,
                  values: { ...state.add.values, verification_method },
                },
              };
              render();
            },
          ),
        ),
      );
      if (state.add.values.verification_method !== 'cert_proof') {
        grid.appendChild(
          makeField(
            'Token hash',
            makeInput(
              'verification_token_hash',
              state.add.values.verification_token_hash,
              (verification_token_hash) => {
                state = {
                  ...state,
                  add: {
                    ...state.add,
                    error: null,
                    values: { ...state.add.values, verification_token_hash },
                  },
                };
              },
            ),
          ),
        );
      }
    }

    const enabled = doc.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = state.add.values.enabled;
    enabled.setAttribute(HOSTNAMES_ADD_FIELD_ATTR, 'enabled');
    enabled.addEventListener('change', () => {
      state = {
        ...state,
        add: {
          ...state.add,
          values: { ...state.add.values, enabled: enabled.checked },
        },
      };
    });
    const enabledLabel = doc.createElement('label');
    enabledLabel.className = 'hostnames-checkbox-label';
    enabledLabel.appendChild(enabled);
    const enabledText = doc.createElement('span');
    enabledText.textContent = 'Enabled';
    enabledLabel.appendChild(enabledText);

    const actions = doc.createElement('div');
    actions.className = 'hostnames-actions';
    actions.appendChild(
      makeButton('Cancel', HOSTNAMES_ADD_CANCEL_BTN_ATTR, 'secondary', () => {
        handle.cancelAdd();
      }, state.add.saving),
    );
    actions.appendChild(
      makeButton(
        state.add.saving ? 'Adding...' : 'Add hostname',
        HOSTNAMES_ADD_SUBMIT_BTN_ATTR,
        'primary',
        () => {
          void handle.submitAdd();
        },
        state.add.saving,
      ),
    );

    form.appendChild(grid);
    form.appendChild(enabledLabel);
    form.appendChild(actions);
    wrapper.appendChild(form);
  };

  const renderUpdateForm = (row: HostnameProjection): HTMLElement | null => {
    if (state.update.hostname !== row.hostname) return null;
    const form = doc.createElement('div');
    form.className = 'hostnames-form';
    form.setAttribute(HOSTNAMES_UPDATE_FORM_ATTR, row.hostname);

    if (state.update.error !== null) form.appendChild(renderError(state.update.error));

    const grid = doc.createElement('div');
    grid.className = 'hostnames-form-grid';
    grid.appendChild(makeField('Cert source', makeUpdateCertSourceSelect()));

    const methods = compatibleMethodsFor(state.update.values.cert_source);
    if (methods.length > 0) {
      grid.appendChild(
        makeField(
          'Proof method',
          makeMethodSelect(
            HOSTNAMES_UPDATE_FIELD_ATTR,
            methods,
            state.update.values.verification_method,
            (verification_method) => {
              state = {
                ...state,
                update: {
                  ...state.update,
                  error: null,
                  values: { ...state.update.values, verification_method },
                },
              };
              render();
            },
          ),
        ),
      );
      if (state.update.values.verification_method !== 'cert_proof') {
        grid.appendChild(
          makeField(
            'New token hash',
            makeInput(
              'verification_token_hash',
              state.update.values.verification_token_hash,
              (verification_token_hash) => {
                state = {
                  ...state,
                  update: {
                    ...state.update,
                    error: null,
                    values: { ...state.update.values, verification_token_hash },
                  },
                };
              },
              HOSTNAMES_UPDATE_FIELD_ATTR,
              true,
            ),
          ),
        );
      }
    }

    const enabled = doc.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = state.update.values.enabled;
    enabled.setAttribute(HOSTNAMES_UPDATE_FIELD_ATTR, 'enabled');
    enabled.addEventListener('change', () => {
      state = {
        ...state,
        update: {
          ...state.update,
          error: null,
          values: { ...state.update.values, enabled: enabled.checked },
        },
      };
    });
    const enabledLabel = doc.createElement('label');
    enabledLabel.className = 'hostnames-checkbox-label';
    enabledLabel.appendChild(enabled);
    const enabledText = doc.createElement('span');
    enabledText.textContent = 'Enabled';
    enabledLabel.appendChild(enabledText);

    const actions = doc.createElement('div');
    actions.className = 'hostnames-actions';
    actions.appendChild(
      makeButton('Cancel', HOSTNAMES_UPDATE_CANCEL_BTN_ATTR, 'secondary', () => {
        handle.cancelUpdate();
      }, state.update.saving),
    );
    actions.appendChild(
      makeButton(
        state.update.saving ? 'Saving...' : 'Save changes',
        HOSTNAMES_UPDATE_SUBMIT_BTN_ATTR,
        'primary',
        () => {
          void handle.submitUpdate();
        },
        state.update.saving,
      ),
    );

    form.appendChild(grid);
    form.appendChild(enabledLabel);
    form.appendChild(actions);
    return form;
  };

  // R26.4 Delta 4 — append the at-a-glance cert-expiry chip when the row
  // carries a cert. `none` severity renders nothing (the meta row already
  // shows "Cert expiry: none"); `warning` / `expired` get a ⚠ glyph + the
  // amber / danger color so the operator spots a lapsing cert without
  // opening the detail. The precise ISO date stays in the meta row.
  const renderCertExpiryChip = (parent: HTMLElement, expires_at: number | undefined): void => {
    const display = formatCertExpiry(expires_at, now());
    if (display.severity === 'none') return;
    const chip = doc.createElement('span');
    chip.className = `hostnames-cert-chip hostnames-cert-chip-${display.severity}`;
    chip.setAttribute(HOSTNAMES_ROW_CERT_EXPIRY_ATTR, display.severity);
    const prefix = display.severity === 'ok' ? '' : '⚠ ';
    chip.textContent = `${prefix}${display.text}`;
    parent.appendChild(chip);
  };

  const renderMeta = (
    parent: HTMLElement,
    label: string,
    value: string,
    mono = false,
  ): void => {
    const box = doc.createElement('div');
    const l = doc.createElement('span');
    l.className = 'hostnames-meta-label';
    l.textContent = label;
    const v = doc.createElement('span');
    v.className = mono
      ? 'hostnames-meta-value hostnames-mono'
      : 'hostnames-meta-value';
    v.textContent = value;
    box.appendChild(l);
    box.appendChild(v);
    parent.appendChild(box);
  };

  const renderDetailPanel = (row: HostnameProjection): HTMLElement | null => {
    if (state.detail.hostname !== row.hostname) return null;
    const panel = doc.createElement('div');
    panel.className = 'hostnames-detail-panel';
    panel.setAttribute(HOSTNAMES_DETAIL_PANEL_ATTR, row.hostname);

    const title = doc.createElement('h4');
    title.className = 'hostnames-detail-title';
    title.textContent = 'Hostname detail';
    panel.appendChild(title);

    if (state.detail.loading) {
      const p = doc.createElement('p');
      p.className = 'hostnames-muted';
      p.setAttribute(HOSTNAMES_PANEL_STATUS_ATTR, '');
      p.textContent = 'Loading hostname detail...';
      panel.appendChild(p);
    } else if (state.detail.error !== null) {
      panel.appendChild(renderError(state.detail.error));
    } else if (state.detail.projection === null) {
      const p = doc.createElement('p');
      p.className = 'hostnames-muted';
      p.setAttribute(HOSTNAMES_PANEL_STATUS_ATTR, '');
      p.textContent = 'Hostname not found.';
      panel.appendChild(p);
    } else {
      const detail = state.detail.projection;
      renderCertExpiryChip(panel, detail.cert_expires_at);
      const meta = doc.createElement('div');
      meta.className = 'hostnames-row-meta';
      renderMeta(meta, 'Hostname id', detail.hostname_id, true);
      renderMeta(meta, 'Hostname', detail.hostname);
      renderMeta(meta, 'Cert source', CERT_SOURCE_LABELS[detail.cert_source]);
      renderMeta(meta, 'Ownership', OWNERSHIP_LABELS[detail.ownership_status]);
      renderMeta(meta, 'TLS topology', detail.tls_topology);
      renderMeta(meta, 'Ports', detail.listener_ports.join(', ') || 'none');
      renderMeta(meta, 'Enabled', detail.enabled ? 'yes' : 'no');
      renderMeta(meta, 'DDNS managed', detail.ddns_managed ? 'yes' : 'no');
      renderMeta(meta, 'Proof method', detail.verification_method
        ? VERIFICATION_METHOD_LABELS[detail.verification_method]
        : 'none');
      renderMeta(meta, 'Cert fingerprint', detail.cert_fingerprint ?? 'none', true);
      renderMeta(meta, 'Cert expiry', formatDate(detail.cert_expires_at));
      renderMeta(meta, 'Cert issuer', detail.cert_chain_metadata?.issuer ?? 'none');
      renderMeta(meta, 'Cert subject', detail.cert_chain_metadata?.subject ?? 'none');
      panel.appendChild(meta);
    }

    const actions = doc.createElement('div');
    actions.className = 'hostnames-actions';
    actions.appendChild(
      makeButton('Close', HOSTNAMES_DETAIL_CLOSE_BTN_ATTR, 'secondary', () => {
        handle.closeDetail();
      }, state.detail.loading),
    );
    panel.appendChild(actions);
    return panel;
  };

  const renderRemoveConfirm = (row: HostnameProjection): HTMLElement | null => {
    if (state.remove.hostname !== row.hostname) return null;
    const panel = doc.createElement('div');
    panel.className = 'hostnames-detail-panel';
    panel.setAttribute(HOSTNAMES_REMOVE_CONFIRM_PANEL_ATTR, row.hostname);

    if (state.remove.error !== null) panel.appendChild(renderError(state.remove.error));
    const p = doc.createElement('p');
    p.className = 'hostnames-muted';
    p.textContent = `Remove ${row.hostname} from the hostname registry?`;
    panel.appendChild(p);

    const actions = doc.createElement('div');
    actions.className = 'hostnames-actions';
    actions.appendChild(
      makeButton('Cancel', HOSTNAMES_REMOVE_CANCEL_BTN_ATTR, 'secondary', () => {
        handle.cancelRemove();
      }, state.remove.saving),
    );
    actions.appendChild(
      makeButton(
        state.remove.saving ? 'Removing...' : 'Confirm remove',
        HOSTNAMES_REMOVE_CONFIRM_BTN_ATTR,
        'danger',
        () => {
          void handle.confirmRemove();
        },
        state.remove.saving,
      ),
    );
    panel.appendChild(actions);
    return panel;
  };

  const renderVerifyForm = (row: HostnameProjection): HTMLElement | null => {
    if (state.verify.hostname !== row.hostname) return null;
    const methods = compatibleMethodsFor(row.cert_source);
    if (methods.length === 0) return null;

    const form = doc.createElement('div');
    form.className = 'hostnames-verify-form';
    form.setAttribute(HOSTNAMES_VERIFY_FORM_ATTR, row.hostname);

    if (state.verify.error !== null) {
      form.appendChild(renderError(state.verify.error, HOSTNAMES_PANEL_ERROR_ATTR));
    } else if (state.verify.result?.ok) {
      const p = doc.createElement('p');
      p.className = 'hostnames-muted';
      p.setAttribute(HOSTNAMES_PANEL_STATUS_ATTR, '');
      p.textContent = state.verify.result.status === 'verified'
        ? 'Ownership verified.'
        : 'Ownership proof failed.';
      form.appendChild(p);
    } else if (state.verify.saving && opts.runExternalProbe !== undefined) {
      const p = doc.createElement('p');
      p.className = 'hostnames-muted';
      p.setAttribute(HOSTNAMES_VERIFY_AUTO_PROBE_STATUS_ATTR, '');
      p.textContent = 'Running external proof probe...';
      form.appendChild(p);
    }

    const grid = doc.createElement('div');
    grid.className = 'hostnames-form-grid';
    grid.appendChild(
      makeField(
        'Proof method',
        makeMethodSelect(
          HOSTNAMES_VERIFY_FIELD_ATTR,
          methods,
          state.verify.method,
          (method) => {
            state = {
              ...state,
              verify: {
                ...state.verify,
                method,
                error: null,
                result: null,
              },
            };
            render();
          },
        ),
      ),
    );

    if (state.verify.method === 'cert_proof') {
      const input = doc.createElement('input');
      input.type = 'checkbox';
      input.checked = state.verify.cert_matches_hostname;
      input.setAttribute(HOSTNAMES_VERIFY_FIELD_ATTR, 'cert_matches_hostname');
      input.addEventListener('change', () => {
        state = {
          ...state,
          verify: {
            ...state.verify,
            cert_matches_hostname: input.checked,
            error: null,
            result: null,
          },
        };
      });
      const label = doc.createElement('label');
      label.className = 'hostnames-checkbox-label';
      label.appendChild(input);
      const text = doc.createElement('span');
      text.textContent = 'Certificate matches hostname';
      label.appendChild(text);
      grid.appendChild(label);
    } else {
      grid.appendChild(
        makeField(
          'Observed token hash',
          makeVerifyInput(
            'observed_token_hash',
            state.verify.observed_token_hash,
            (observed_token_hash) => {
              state = {
                ...state,
                verify: {
                  ...state.verify,
                  observed_token_hash,
                  error: null,
                  result: null,
                },
              };
            },
          ),
        ),
      );
    }

    const actions = doc.createElement('div');
    actions.className = 'hostnames-actions';
    actions.appendChild(
      makeButton('Cancel', HOSTNAMES_VERIFY_CANCEL_BTN_ATTR, 'secondary', () => {
        handle.cancelVerify();
      }, state.verify.saving),
    );
    actions.appendChild(
      makeButton(
        state.verify.saving ? 'Verifying...' : 'Verify ownership',
        HOSTNAMES_VERIFY_SUBMIT_BTN_ATTR,
        'primary',
        () => {
          void handle.submitVerify();
        },
        state.verify.saving,
      ),
    );

    form.appendChild(grid);
    form.appendChild(actions);
    return form;
  };

  const renderRows = (): void => {
    if (state.loading) {
      const p = doc.createElement('p');
      p.className = 'hostnames-muted';
      p.setAttribute(HOSTNAMES_PANEL_STATUS_ATTR, '');
      p.textContent = 'Loading hostnames...';
      wrapper.appendChild(p);
      return;
    }
    if (state.hostnames.length === 0) {
      const p = doc.createElement('p');
      p.className = 'hostnames-muted';
      p.setAttribute(HOSTNAMES_PANEL_EMPTY_ATTR, '');
      p.textContent = 'No hostnames registered.';
      wrapper.appendChild(p);
      return;
    }

    const list = doc.createElement('div');
    list.className = 'hostnames-panel-list';
    for (const row of state.hostnames) {
      const item = doc.createElement('div');
      item.className = 'hostnames-row';
      item.setAttribute(HOSTNAMES_ROW_ATTR, row.hostname);

      const main = doc.createElement('div');
      main.className = 'hostnames-row-main';
      const name = doc.createElement('div');
      name.className = 'hostnames-row-name';
      name.textContent = row.hostname;
      const pill = doc.createElement('span');
      pill.className = `hostnames-pill ${OWNERSHIP_CLASS[row.ownership_status]}`;
      pill.setAttribute(HOSTNAMES_ROW_STATUS_ATTR, row.ownership_status);
      pill.textContent = OWNERSHIP_LABELS[row.ownership_status];
      main.appendChild(name);
      main.appendChild(pill);
      renderCertExpiryChip(main, row.cert_expires_at);

      const meta = doc.createElement('div');
      meta.className = 'hostnames-row-meta';
      renderMeta(meta, 'Cert source', CERT_SOURCE_LABELS[row.cert_source]);
      renderMeta(meta, 'TLS topology', row.tls_topology);
      renderMeta(meta, 'Ports', row.listener_ports.join(', ') || 'none');
      renderMeta(meta, 'Enabled', row.enabled ? 'yes' : 'no');
      renderMeta(meta, 'DDNS managed', row.ddns_managed ? 'yes' : 'no');
      renderMeta(meta, 'Proof method', row.verification_method
        ? VERIFICATION_METHOD_LABELS[row.verification_method]
        : 'none');
      renderMeta(meta, 'Cert fingerprint', shortFingerprint(row.cert_fingerprint), true);
      renderMeta(meta, 'Cert expiry', formatDate(row.cert_expires_at));

      item.appendChild(main);
      item.appendChild(meta);

      const actions = doc.createElement('div');
      actions.className = 'hostnames-actions';
      actions.appendChild(
        makeButton(
          'Details',
          HOSTNAMES_DETAIL_OPEN_BTN_ATTR,
          'secondary',
          () => {
            void handle.openDetail(row.hostname);
          },
          state.detail.loading && state.detail.hostname === row.hostname,
        ),
      );
      actions.appendChild(
        makeButton(
          'Edit',
          HOSTNAMES_UPDATE_OPEN_BTN_ATTR,
          'secondary',
          () => {
            handle.openUpdate(row.hostname);
          },
          state.update.saving || state.remove.saving,
        ),
      );
      if (row.cert_source !== 'recued_acme') {
        actions.appendChild(
          makeButton(
            row.ownership_status === 'verified' ? 'Re-verify' : 'Verify',
            HOSTNAMES_VERIFY_OPEN_BTN_ATTR,
            'secondary',
            () => {
              handle.openVerify(row.hostname);
            },
          ),
        );
      }
      actions.appendChild(
        makeButton(
          'Remove',
          HOSTNAMES_REMOVE_OPEN_BTN_ATTR,
          'danger',
          () => {
            handle.openRemove(row.hostname);
          },
          state.update.saving || state.remove.saving,
        ),
      );
      item.appendChild(actions);

      const detailPanel = renderDetailPanel(row);
      if (detailPanel !== null) item.appendChild(detailPanel);
      const updateForm = renderUpdateForm(row);
      if (updateForm !== null) item.appendChild(updateForm);
      const removeConfirm = renderRemoveConfirm(row);
      if (removeConfirm !== null) item.appendChild(removeConfirm);
      const verifyForm = renderVerifyForm(row);
      if (verifyForm !== null) item.appendChild(verifyForm);
      list.appendChild(item);
    }
    wrapper.appendChild(list);
  };

  // R27 delta-B — flip the Pro DDNS publish state (pause/resume). Cloud-first
  // happens server-side; here we busy-gate, call the rpc, adopt the returned
  // effective `enabled`, and surface failures inline (mirrors the server-pill
  // pause control). Refreshes nothing else — pause only affects this slice.
  const doSetDdnsEnabled = async (enabled: boolean): Promise<void> => {
    if (opts.runDdnsSetEnabled === undefined || state.ddns.busy) return;
    state = { ...state, ddns: { ...state.ddns, busy: true, error: null } };
    render();
    try {
      const res = await opts.runDdnsSetEnabled({ enabled });
      if (disposed) return;
      state = { ...state, ddns: { ...state.ddns, busy: false, enabled: res.enabled } };
    } catch (err) {
      if (disposed) return;
      state = { ...state, ddns: { ...state.ddns, busy: false, error: errMessage(err) } };
    }
    render();
  };

  // R27 delta-B — the Pro DDNS pause/resume control. Renders ONLY when DDNS is
  // published (`state.ddns.available`), so a pause can never be issued before a
  // cloud record exists. If this webclient is connected VIA the handle, the
  // toggle is BLOCKED (pausing would sever this connection) until the user
  // re-points Server URL.
  const renderProDdns = (): void => {
    if (!state.ddns.available) return;
    const section = doc.createElement('div');
    section.className = 'hostnames-ddns';
    section.setAttribute(HOSTNAMES_DDNS_SECTION_ATTR, '');

    const title = doc.createElement('h3');
    title.className = 'hostnames-local-urls-title';
    title.textContent = 'Pro web address (DDNS)';
    section.appendChild(title);

    const host = state.ddns.hostname ?? 'Your Pro web address';
    const status = doc.createElement('p');
    status.className = 'hostnames-muted';
    status.setAttribute(HOSTNAMES_DDNS_STATE_ATTR, state.ddns.enabled ? 'published' : 'paused');
    status.textContent = state.ddns.enabled
      ? `${host} is published and resolving to this server.`
      : `${host} is paused — it does not resolve to this server right now.`;
    section.appendChild(status);

    if (state.ddns.blockToggle) {
      const blocked = doc.createElement('p');
      blocked.className = 'hostnames-muted';
      blocked.setAttribute(HOSTNAMES_DDNS_BLOCKED_ATTR, '');
      blocked.textContent =
        `Pausing could cut this webclient's connection — it may be reaching your server ` +
        `through ${host}. Switch to another address (a LAN URL or a custom domain) in ` +
        'Settings → Server URL and reconnect, then you can pause.';
      section.appendChild(blocked);
      wrapper.appendChild(section);
      return;
    }

    if (state.ddns.enabled) {
      const warn = doc.createElement('p');
      warn.className = 'hostnames-muted';
      warn.textContent =
        `Pausing stops ${host} from pointing to your server — anything reaching it through ` +
        'that address (including your own remote access) goes dark until you resume. It does ' +
        'NOT cancel your Pro subscription: billing continues and a renewal will not un-pause it. ' +
        'Manage billing in the dashboard.';
      section.appendChild(warn);
      section.appendChild(
        makeButton('Pause DDNS', HOSTNAMES_DDNS_TOGGLE_ATTR, 'danger', () => {
          void doSetDdnsEnabled(false);
        }, state.ddns.busy),
      );
    } else {
      section.appendChild(
        makeButton('Resume DDNS', HOSTNAMES_DDNS_TOGGLE_ATTR, 'primary', () => {
          void doSetDdnsEnabled(true);
        }, state.ddns.busy),
      );
    }

    if (state.ddns.error !== null) {
      const err = renderError(state.ddns.error);
      err.setAttribute(HOSTNAMES_DDNS_ERROR_ATTR, '');
      section.appendChild(err);
    }
    wrapper.appendChild(section);
  };

  const renderLocalUrls = (): void => {
    // Render only when at least one address is known — this covers both the
    // "no caller" case (the slice stays empty) and the brief in-flight window,
    // so the section never flickers an empty header.
    if (state.localUrls.length === 0) return;
    const section = doc.createElement('div');
    section.className = 'hostnames-local-urls';
    section.setAttribute(HOSTNAMES_LOCAL_URLS_ATTR, '');

    const title = doc.createElement('h3');
    title.className = 'hostnames-local-urls-title';
    title.textContent = 'Reachable on your network';
    section.appendChild(title);

    const desc = doc.createElement('p');
    desc.className = 'hostnames-muted hostnames-local-urls-desc';
    desc.textContent =
      'Use these addresses to reach this server from other devices on your LAN.';
    section.appendChild(desc);

    for (const entry of state.localUrls) {
      const row = doc.createElement('div');
      row.className = 'hostnames-local-url-row';
      row.setAttribute(HOSTNAMES_LOCAL_URL_ROW_ATTR, entry.url);

      const value = doc.createElement('span');
      value.className = 'hostnames-mono hostnames-local-url-value';
      value.textContent = entry.url;
      row.appendChild(value);

      const kind = doc.createElement('span');
      kind.className = `hostnames-pill hostnames-local-url-kind-${entry.kind}`;
      kind.setAttribute(HOSTNAMES_LOCAL_URL_KIND_ATTR, entry.kind);
      kind.textContent = LOCAL_URL_KIND_LABELS[entry.kind];
      row.appendChild(kind);

      section.appendChild(row);
    }
    wrapper.appendChild(section);
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren(wrapper);

    const header = doc.createElement('div');
    header.className = 'hostnames-panel-header';
    const title = doc.createElement('h3');
    title.className = 'hostnames-panel-title';
    title.textContent = 'Hostnames';
    header.appendChild(title);
    header.appendChild(
      makeButton('Add hostname', HOSTNAMES_ADD_OPEN_BTN_ATTR, 'primary', () => {
        handle.openAdd();
      }, state.add.open || state.add.saving),
    );
    wrapper.appendChild(header);

    if (state.error !== null) wrapper.appendChild(renderError(state.error));
    renderProDdns();
    renderAddForm();
    renderRows();
    renderLocalUrls();
  };

  const doRefresh = (): Promise<void> => {
    const gen = ++loadGeneration;
    state = { ...state, loading: true, error: null };
    render();
    const listLoad = (async () => {
      try {
        const result = await opts.runList();
        if (disposed || gen !== loadGeneration) return;
        state = {
          ...state,
          loading: false,
          error: null,
          hostnames: [...result.hostnames],
        };
      } catch (err) {
        if (disposed || gen !== loadGeneration) return;
        state = {
          ...state,
          loading: false,
          error: errMessage(err),
        };
      }
      render();
    })();
    // LAN-URL kickstart (slice 2) — a SEPARATE fetch so a slow/failing
    // `network.local_urls` never delays the registry rows. On failure the
    // slice stays empty (the section simply doesn't render), mirroring the
    // null-safe list path. Both loads mutate disjoint state slices, so the
    // last writer's `{ ...state }` preserves the other's result.
    const localUrlsLoad = (async () => {
      if (opts.runLocalUrls === undefined) return;
      try {
        const result = await opts.runLocalUrls();
        if (disposed || gen !== loadGeneration) return;
        state = { ...state, localUrls: [...result.urls] };
      } catch {
        if (disposed || gen !== loadGeneration) return;
        state = { ...state, localUrls: [] };
      }
      render();
    })();
    // R27 delta-B — Pro DDNS control state, fetched separately (same non-
    // blocking discipline as the LAN URLs). Both the status (enabled) + the
    // composed gate context (published / hostname / self-connected) are read;
    // on any failure the section silently does not render.
    const ddnsLoad = (async () => {
      if (opts.runDdnsStatus === undefined || opts.runDdnsControlContext === undefined) {
        return;
      }
      try {
        const [status, context] = await Promise.all([
          opts.runDdnsStatus(),
          opts.runDdnsControlContext(),
        ]);
        if (disposed || gen !== loadGeneration) return;
        state = {
          ...state,
          ddns: {
            ...state.ddns,
            available: context.published,
            enabled: status.enabled,
            blockToggle: context.blockToggle,
            hostname: context.ddnsHostname,
            error: null,
          },
        };
      } catch {
        if (disposed || gen !== loadGeneration) return;
        state = { ...state, ddns: { ...state.ddns, available: false } };
      }
      render();
    })();
    pendingLoad = Promise.all([listLoad, localUrlsLoad, ddnsLoad]).then(() => undefined);
    return pendingLoad;
  };

  const validateAdd = (): string | null => {
    const values = state.add.values;
    if (values.hostname.trim() === '') return 'Hostname is required.';
    if (
      values.cert_source !== 'recued_acme'
      && values.verification_method !== 'cert_proof'
      && values.verification_token_hash.trim() === ''
    ) {
      return 'Token hash is required for HTTP token and DNS TXT proofs.';
    }
    return null;
  };

  const buildAddRequest = (): HostnameAddRequest => {
    const values = state.add.values;
    const req: HostnameAddRequest = {
      hostname: values.hostname.trim(),
      cert_source: values.cert_source,
      enabled: values.enabled,
    };
    if (values.cert_source !== 'recued_acme') {
      req.verification_method = values.verification_method;
      if (values.verification_method !== 'cert_proof') {
        req.verification_token_hash = values.verification_token_hash.trim();
      }
    }
    return req;
  };

  const submitAdd = async (): Promise<void> => {
    if (disposed || state.add.saving) return;
    const validation = validateAdd();
    if (validation !== null) {
      state = { ...state, add: { ...state.add, error: validation } };
      render();
      return;
    }

    const values = state.add.values;
    state = {
      ...state,
      add: { ...state.add, saving: true, error: null },
    };
    render();
    try {
      const result = await opts.runAdd(buildAddRequest());
      if (disposed) return;
      const nextVerify =
        result.hostname.cert_source === 'recued_acme'
          ? { ...DEFAULT_VERIFY_VALUES }
          : {
              ...DEFAULT_VERIFY_VALUES,
              hostname: result.hostname.hostname,
              method: result.hostname.verification_method
                ?? defaultMethodFor(result.hostname.cert_source),
              observed_token_hash: values.verification_token_hash,
            };
      state = {
        ...state,
        hostnames: upsertProjection(state.hostnames, result.hostname),
        add: {
          open: false,
          saving: false,
          error: null,
          values: { ...DEFAULT_ADD_VALUES },
        },
        verify: nextVerify,
      };
    } catch (err) {
      if (disposed) return;
      state = {
        ...state,
        add: { ...state.add, saving: false, error: errMessage(err) },
      };
    }
    render();
  };

  const selectedUpdateRow = (): HostnameProjection | null => {
    const hostname = state.update.hostname;
    if (hostname === null) return null;
    return state.hostnames.find((h) => h.hostname === hostname) ?? null;
  };

  const proofConfigWillChange = (row: HostnameProjection): boolean => {
    const values = state.update.values;
    if (values.cert_source === 'recued_acme') return false;
    if (values.cert_source !== row.cert_source) return true;
    const currentMethod = row.verification_method ?? defaultMethodFor(row.cert_source);
    if (values.verification_method !== currentMethod) return true;
    return values.verification_token_hash.trim() !== '';
  };

  const validateUpdate = (): string | null => {
    const row = selectedUpdateRow();
    if (row === null) return 'Choose a hostname to update.';
    const values = state.update.values;
    const methods = compatibleMethodsFor(values.cert_source);
    if (methods.length > 0 && !methods.includes(values.verification_method)) {
      return 'Proof method is not compatible with this cert source.';
    }
    if (
      proofConfigWillChange(row)
      && values.cert_source !== 'recued_acme'
      && values.verification_method !== 'cert_proof'
      && values.verification_token_hash.trim() === ''
    ) {
      return 'Token hash is required when changing to HTTP token or DNS TXT proof.';
    }
    return null;
  };

  const buildUpdateRequest = (row: HostnameProjection): HostnameUpdateRequest | null => {
    const values = state.update.values;
    const req: HostnameUpdateRequest = { hostname: row.hostname };
    if (values.enabled !== row.enabled) req.enabled = values.enabled;
    if (values.cert_source !== row.cert_source) req.cert_source = values.cert_source;

    if (proofConfigWillChange(row) && values.cert_source !== 'recued_acme') {
      req.verification_method = values.verification_method;
      if (values.verification_method !== 'cert_proof') {
        req.verification_token_hash = values.verification_token_hash.trim();
      }
    }

    return Object.keys(req).length > 1 ? req : null;
  };

  const submitUpdate = async (): Promise<void> => {
    if (disposed || state.update.saving) return;
    const row = selectedUpdateRow();
    const validation = validateUpdate();
    if (row === null || validation !== null) {
      state = {
        ...state,
        update: { ...state.update, error: validation ?? 'Choose a hostname to update.' },
      };
      render();
      return;
    }
    const request = buildUpdateRequest(row);
    if (request === null) {
      state = {
        ...state,
        update: { ...state.update, error: 'No changes to save.' },
      };
      render();
      return;
    }

    state = {
      ...state,
      update: { ...state.update, saving: true, error: null },
    };
    render();
    try {
      const result = await opts.runUpdate(request);
      if (disposed) return;
      state = {
        ...state,
        hostnames: upsertProjection(state.hostnames, result.hostname),
        update: {
          hostname: null,
          saving: false,
          error: null,
          values: { ...DEFAULT_UPDATE_VALUES },
        },
        detail: state.detail.hostname === result.hostname.hostname
          ? {
              hostname: result.hostname.hostname,
              loading: false,
              error: null,
              projection: result.hostname,
            }
          : state.detail,
      };
    } catch (err) {
      if (disposed) return;
      state = {
        ...state,
        update: { ...state.update, saving: false, error: errMessage(err) },
      };
    }
    render();
  };

  const loadDetail = async (hostname: string): Promise<void> => {
    if (disposed) return;
    const gen = ++detailGeneration;
    state = {
      ...state,
      add: { ...state.add, open: false },
      update: {
        hostname: null,
        saving: false,
        error: null,
        values: { ...DEFAULT_UPDATE_VALUES },
      },
      remove: { ...DEFAULT_REMOVE_VALUES },
      verify: { ...DEFAULT_VERIFY_VALUES },
      detail: {
        hostname,
        loading: true,
        error: null,
        projection: null,
      },
    };
    render();
    try {
      const result = await opts.runGet({ hostname });
      if (disposed || gen !== detailGeneration) return;
      state = {
        ...state,
        hostnames: result.hostname === null
          ? removeProjection(state.hostnames, hostname)
          : upsertProjection(state.hostnames, result.hostname),
        detail: {
          hostname,
          loading: false,
          error: null,
          projection: result.hostname,
        },
      };
    } catch (err) {
      if (disposed || gen !== detailGeneration) return;
      state = {
        ...state,
        detail: {
          hostname,
          loading: false,
          error: errMessage(err),
          projection: null,
        },
      };
    }
    render();
  };

  const confirmRemove = async (): Promise<void> => {
    if (disposed || state.remove.saving || state.remove.hostname === null) return;
    const hostname = state.remove.hostname;
    state = {
      ...state,
      remove: { ...state.remove, saving: true, error: null },
    };
    render();
    try {
      await opts.runRemove({ hostname });
      if (disposed) return;
      state = {
        ...state,
        hostnames: removeProjection(state.hostnames, hostname),
        detail: state.detail.hostname === hostname ? { ...DEFAULT_DETAIL_VALUES } : state.detail,
        update: state.update.hostname === hostname
          ? {
              hostname: null,
              saving: false,
              error: null,
              values: { ...DEFAULT_UPDATE_VALUES },
            }
          : state.update,
        remove: { ...DEFAULT_REMOVE_VALUES },
        verify: state.verify.hostname === hostname ? { ...DEFAULT_VERIFY_VALUES } : state.verify,
      };
    } catch (err) {
      if (disposed) return;
      state = {
        ...state,
        remove: { ...state.remove, saving: false, error: errMessage(err) },
      };
    }
    render();
  };

  const selectedVerifyRow = (): HostnameProjection | null => {
    const hostname = state.verify.hostname;
    if (hostname === null) return null;
    return state.hostnames.find((h) => h.hostname === hostname) ?? null;
  };

  const validateVerify = (): string | null => {
    if (state.verify.hostname === null) return 'Choose a hostname to verify.';
    if (
      state.verify.method !== 'cert_proof'
      && state.verify.observed_token_hash.trim() === ''
      && opts.runExternalProbe === undefined
    ) {
      return 'Observed token hash is required.';
    }
    return null;
  };

  const buildVerifyRequest = (): HostnameOwnershipProofInput => {
    const hostname = state.verify.hostname ?? '';
    if (state.verify.method === 'cert_proof') {
      return {
        hostname,
        method: 'cert_proof',
        cert_matches_hostname: state.verify.cert_matches_hostname,
      };
    }
    return {
      hostname,
      method: state.verify.method,
      observed_token_hash: state.verify.observed_token_hash.trim(),
    };
  };

  const submitVerify = async (): Promise<void> => {
    if (disposed || state.verify.saving) return;
    const row = selectedVerifyRow();
    const validation = validateVerify();
    if (row === null || validation !== null) {
      state = {
        ...state,
        verify: {
          ...state.verify,
          error: validation ?? 'Choose a hostname to verify.',
          result: null,
        },
      };
      render();
      return;
    }

    state = {
      ...state,
      verify: { ...state.verify, saving: true, error: null, result: null },
    };
    render();
    try {
      let request = buildVerifyRequest();
      if (
        opts.runExternalProbe !== undefined
        && (
          state.verify.method === 'cert_proof'
          || state.verify.observed_token_hash.trim() === ''
        )
      ) {
        const response = await opts.runExternalProbe({
          hostname: row.hostname,
          ...(state.verify.method === 'http_token' || state.verify.method === 'dns_txt'
            ? { ownership_probe_method: state.verify.method }
            : {}),
        });
        const autoRequest = buildAutoVerifyRequest(row, state.verify.method, response);
        if (autoRequest === null) {
          throw new Error(
            state.verify.method === 'cert_proof'
              ? 'External probe did not return TLS proof for this hostname.'
              : 'External probe did not return an observed token hash for this hostname.',
          );
        }
        request = autoRequest;
        state = {
          ...state,
          verify: {
            ...state.verify,
            observed_token_hash:
              autoRequest.method === 'cert_proof'
                ? state.verify.observed_token_hash
                : autoRequest.observed_token_hash,
            cert_matches_hostname:
              autoRequest.method === 'cert_proof'
                ? autoRequest.cert_matches_hostname
                : state.verify.cert_matches_hostname,
            error: null,
            result: null,
          },
        };
        render();
      }
      const result = await opts.runVerifyOwnership(request);
      if (disposed) return;
      const nextRows = result.ok
        ? upsertProjection(state.hostnames, result.projection)
        : state.hostnames;
      state = {
        ...state,
        hostnames: nextRows,
        verify: {
          ...state.verify,
          saving: false,
          error: result.ok ? null : proofFailureCopy(result),
          result,
        },
      };
    } catch (err) {
      if (disposed) return;
      state = {
        ...state,
        verify: {
          ...state.verify,
          saving: false,
          error: errMessage(err),
          result: null,
        },
      };
    }
    render();
  };

  const handle: HostnamesPanelMount = {
    getState: () => state,
    refresh: doRefresh,
    whenLoaded: () => pendingLoad,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      wrapper.remove();
    },
    openAdd: () => {
      if (disposed) return;
      state = {
        ...state,
        add: {
          open: true,
          saving: false,
          error: null,
          values: { ...DEFAULT_ADD_VALUES },
        },
        update: {
          hostname: null,
          saving: false,
          error: null,
          values: { ...DEFAULT_UPDATE_VALUES },
        },
        detail: { ...DEFAULT_DETAIL_VALUES },
        remove: { ...DEFAULT_REMOVE_VALUES },
        verify: { ...DEFAULT_VERIFY_VALUES },
      };
      render();
    },
    cancelAdd: () => {
      if (disposed) return;
      state = {
        ...state,
        add: {
          open: false,
          saving: false,
          error: null,
          values: { ...DEFAULT_ADD_VALUES },
        },
      };
      render();
    },
    setAddField: (field, value) => {
      if (disposed) return;
      const nextValues = { ...state.add.values };
      if (field === 'enabled') {
        nextValues.enabled = Boolean(value);
      } else if (field === 'cert_source') {
        const cert_source = value as HostnameCertSource;
        nextValues.cert_source = cert_source;
        nextValues.verification_method = defaultMethodFor(cert_source);
        if (cert_source === 'recued_acme') nextValues.verification_token_hash = '';
      } else if (field === 'verification_method') {
        nextValues.verification_method = value as HostnameVerificationMethod;
      } else {
        nextValues[field] = String(value);
      }
      state = {
        ...state,
        add: { ...state.add, error: null, values: nextValues },
      };
      render();
    },
    submitAdd,
    openDetail: loadDetail,
    closeDetail: () => {
      if (disposed) return;
      detailGeneration += 1;
      state = { ...state, detail: { ...DEFAULT_DETAIL_VALUES } };
      render();
    },
    openUpdate: (hostname) => {
      if (disposed) return;
      const row = state.hostnames.find((h) => h.hostname === hostname);
      if (!row || state.update.saving || state.remove.saving) return;
      state = {
        ...state,
        add: { ...state.add, open: false },
        update: {
          hostname: row.hostname,
          saving: false,
          error: null,
          values: updateValuesFor(row),
        },
        detail: { ...DEFAULT_DETAIL_VALUES },
        remove: { ...DEFAULT_REMOVE_VALUES },
        verify: { ...DEFAULT_VERIFY_VALUES },
      };
      render();
    },
    cancelUpdate: () => {
      if (disposed || state.update.saving) return;
      state = {
        ...state,
        update: {
          hostname: null,
          saving: false,
          error: null,
          values: { ...DEFAULT_UPDATE_VALUES },
        },
      };
      render();
    },
    setUpdateField: (field, value) => {
      if (disposed || state.update.hostname === null) return;
      const nextValues = { ...state.update.values };
      if (field === 'enabled') {
        nextValues.enabled = Boolean(value);
      } else if (field === 'cert_source') {
        const cert_source = value as HostnameCertSource;
        nextValues.cert_source = cert_source;
        nextValues.verification_method = defaultMethodFor(cert_source);
        if (cert_source === 'recued_acme') nextValues.verification_token_hash = '';
      } else if (field === 'verification_method') {
        const method = value as HostnameVerificationMethod;
        const methods = compatibleMethodsFor(nextValues.cert_source);
        nextValues.verification_method = methods.includes(method)
          ? method
          : methods[0] ?? 'dns_txt';
      } else {
        nextValues.verification_token_hash = String(value);
      }
      state = {
        ...state,
        update: { ...state.update, error: null, values: nextValues },
      };
      render();
    },
    submitUpdate,
    openRemove: (hostname) => {
      if (disposed || state.update.saving || state.remove.saving) return;
      const row = state.hostnames.find((h) => h.hostname === hostname);
      if (!row) return;
      state = {
        ...state,
        add: { ...state.add, open: false },
        update: {
          hostname: null,
          saving: false,
          error: null,
          values: { ...DEFAULT_UPDATE_VALUES },
        },
        detail: { ...DEFAULT_DETAIL_VALUES },
        remove: { hostname: row.hostname, saving: false, error: null },
        verify: { ...DEFAULT_VERIFY_VALUES },
      };
      render();
    },
    cancelRemove: () => {
      if (disposed || state.remove.saving) return;
      state = { ...state, remove: { ...DEFAULT_REMOVE_VALUES } };
      render();
    },
    confirmRemove,
    openVerify: (hostname) => {
      if (disposed) return;
      const row = state.hostnames.find((h) => h.hostname === hostname);
      if (!row) return;
      const method =
        row.verification_method
        ?? defaultMethodFor(row.cert_source);
      state = {
        ...state,
        add: { ...state.add, open: false },
        update: {
          hostname: null,
          saving: false,
          error: null,
          values: { ...DEFAULT_UPDATE_VALUES },
        },
        detail: { ...DEFAULT_DETAIL_VALUES },
        remove: { ...DEFAULT_REMOVE_VALUES },
        verify: {
          ...DEFAULT_VERIFY_VALUES,
          hostname: row.hostname,
          method,
        },
      };
      render();
    },
    cancelVerify: () => {
      if (disposed) return;
      state = { ...state, verify: { ...DEFAULT_VERIFY_VALUES } };
      render();
    },
    setVerifyField: (field, value) => {
      if (disposed) return;
      const row = selectedVerifyRow();
      if (row === null) return;
      const nextVerify: VerifyValues = {
        ...state.verify,
        error: null,
        result: null,
      };
      if (field === 'cert_matches_hostname') {
        nextVerify.cert_matches_hostname = Boolean(value);
      } else if (field === 'method') {
        const method = value as HostnameVerificationMethod;
        const methods = compatibleMethodsFor(row.cert_source);
        nextVerify.method = methods.includes(method) ? method : methods[0] ?? 'dns_txt';
      } else {
        nextVerify.observed_token_hash = String(value);
      }
      state = { ...state, verify: nextVerify };
      render();
    },
    submitVerify,
  };

  render();
  void doRefresh();
  return handle;
};
