/** D-148 § A.10 + § P6 — Settings → Server → Reachability page renderer.
 *
 *  Pure projection of a `ReachabilityReport` into a render-ready
 *  model. The webclient's UI iterates over the model + emits one
 *  card per port + per webhook + per recommendation. The actual
 *  fetch (the rpc that returns the report) is the caller's
 *  responsibility — this module only builds the model.
 *
 *  The cloud-probe button surfaces here too: the renderer carries a
 *  `can_run_cloud_probe` flag derived from the cloud-probe rate-limit
 *  hint shipped with the report. */

import {
  HOSTNAME_LISTENER_PORTS,
  type DiagnosticOwnershipProofMethod,
  type DiagnosticKind,
  type DiagnosticRequest,
  type DiagnosticResponse,
  type DiagnosticResult,
  ReachabilityRecommendation,
  ReachabilityRecommendationCode,
  ReachabilityReport,
  ReachabilityPathEntry,
  ReachabilityPerDomainTlsEntry,
  ReachabilityWebhookEntry,
  ReachabilityBridgeEntry,
  ReachabilityWebclientEntry,
} from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

export const REACHABILITY_PANEL_ATTR = 'data-recued-reachability-panel';
export const REACHABILITY_RUN_EXTERNAL_PROBE_BTN_ATTR =
  'data-recued-reachability-run-external-probe';
export const REACHABILITY_PROBE_RESULTS_ATTR =
  'data-recued-reachability-probe-results';
export const REACHABILITY_PROBE_ERROR_ATTR =
  'data-recued-reachability-probe-error';

const RUN_EXTERNAL_PROBE_ACTION = 'reachability-run-external-probe';
// D-176 Phase 5 — the reachability + diagnostics probes split out of the
// sync-worker (api host) onto the standalone probe Worker at its own subdomain
// (spec § 5; `wrangler.probe.toml`). The api host now 404s `/v1/diagnostics/probe`.
const DEFAULT_DIAGNOSTIC_API_BASE_URL = 'https://probe.recued.com';
const DEFAULT_DIAGNOSTIC_CHECKS: ReadonlyArray<DiagnosticKind> = [
  'detected_public_ip',
  'port_reachability',
  'dns_resolution',
  'tls_handshake',
  'nat_class',
];

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type ReachabilityDiagnosticFetch = FetchLike;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const errorMessage = (err: unknown): string =>
  humanizeRpcError(err);

const apiErrorMessage = (body: unknown, status: number): string => {
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === 'string' ? body.error.code : null;
    const message =
      typeof body.error.message === 'string' ? body.error.message : null;
    if (code && message) return `${code}: ${message}`;
    if (message) return message;
    if (code) return code;
  }
  return `the check failed: HTTP ${status}`;
};

const readApiData = <T>(body: unknown): T => {
  if (isRecord(body) && 'data' in body) return body.data as T;
  throw new Error('Recued could not read the answer to its check');
};

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

const diagnosticProbeUrl = (baseUrl: string): string =>
  new URL('/v1/diagnostics/probe', normalizeBaseUrl(baseUrl)).toString();

const defaultFetch: FetchLike = async (input, init) => {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof f !== 'function') {
    throw new Error('Recued cannot run the check from here');
  }
  return f(input, init);
};

/** Per-recommendation remediation copy keyed on the closed-list
 *  code. Used as a fallback when the report itself doesn't ship a
 *  remediation hint. The webclient localizes these — strings here
 *  are the canonical English source.
 *
 *  D-149 P1 codex fold — `ReachabilityRecommendationCode` widened
 *  with three Reception codes per § A.8; the exhaustive Record gets
 *  remediation copy for each so `npm run build` stays green and the
 *  Settings UI never shows a silent blank fallback when the doctor
 *  emits a Reception finding. */
export const REMEDIATION_COPY: Record<ReachabilityRecommendationCode, string> = {
  tls_renewal_overdue: 'Get a new certificate: Settings, Server, Key Health, Renew.',
  tls_renewal_imminent: 'Recued will renew this by itself within 14 days. You do not need to do anything.',
  ddns_ip_mismatch: 'Refresh your web address: Settings, Server, then Refresh.',
  webhook_inbound_silent: 'Check your router lets traffic through, and check the shared secret, under Settings, Connections.',
  webhook_hmac_failure: 'Connect it again under Settings, Connections. The shared secret may have changed.',
  bridge_offline: 'Check the Browser Bridge is installed and switched on in their browser.',
  cert_fingerprint_mismatch: 'Somebody may be listening in. Pair every device again, and get a new certificate under Settings, Server, Key Health.',
  path_unreachable_from_cloud: 'Check your router lets traffic through to this server. If it cannot, switch to your own network only.',
  nat_traversal_required: 'Set your router to let traffic through by hand. It cannot do it automatically on this network.',
  exposure_resolution_inconsistent: 'Pick a preset again under Settings, Server, Exposure. Or check the list below it for anything out of place.',
  reception_listener_silent: 'Your Reception page is open, but nobody has been. Check the links you shared really work, or switch off the ones you are not using, under Settings, Server, Reception.',
  reception_endpoint_unreachable: 'Recued tested one of your Reception links and it did not work. Find it under Settings, Server, Reception, then share it again or give it a new key.',
  reception_cert_san_missing_hostname: 'Your certificate does not cover the name your Reception page uses. Get a new one that does. With Pro: Settings, Server, Refresh. Otherwise run your own certificate tool again.',
  tls_chain_invalid_for_domain: 'One of your certificates no longer traces back to anyone your computer trusts. Upload the certificate again, along with the chain from whoever issued it, under Settings, Server, TLS Certificates.',
};

/** Severity sort order matching the rpc projection. Errors first
 *  drives the top-of-page recommendation feed. */
export const RECOMMENDATION_SEVERITY_ORDER = ['error', 'warning', 'info'] as const;

export interface ReachabilityRenderModel {
  /** Top-of-page severity summary — cardinality of each severity
   *  level + the most-severe one for the badge. */
  severity_summary: {
    error_count: number;
    warning_count: number;
    info_count: number;
    badge: 'healthy' | 'attention' | 'critical';
  };
  network_summary: {
    public_ip: string | null;
    behind_nat: boolean;
    handle: string | null;
    handle_resolves: boolean;
    handle_resolves_to_expected_ip: boolean;
  };
  tls_summary: {
    fingerprint_short: string;
    days_until_expiry: number;
    issuer: string;
    valid_for_handle: boolean;
  };
  per_path: ReachabilityPathEntry[];
  /** D-148 FU2 — per-domain TLS health rollup from
   *  `TLSDomainStore.list()`. Empty array when the server has no
   *  per-domain certs configured. Render position: directly below
   *  `tls_summary` (the single primary cert), matching the
   *  per-domain TLS Certificates page hierarchy. */
  per_domain_tls: ReachabilityPerDomainTlsEntry[];
  webhooks: ReachabilityWebhookEntry[];
  bridges: ReachabilityBridgeEntry[];
  webclients: ReachabilityWebclientEntry[];
  recommendations: Array<{
    severity: ReachabilityRecommendation['severity'];
    code: ReachabilityRecommendationCode;
    message: string;
    remediation: string;
  }>;
  /** True when the cloud probe is available (rate budget + DNS
   *  handle present). UI uses this to enable / disable the
   *  "Run external probe" button. */
  can_run_cloud_probe: boolean;
}

export interface ReachabilityDiagnosticTarget {
  account_id: string;
  hostname: string;
  expected_public_ip?: string;
  acme_challenge_token?: string;
  ownership_probe_method?: DiagnosticOwnershipProofMethod;
}

export const buildReachabilityDiagnosticRequest = (
  target: ReachabilityDiagnosticTarget,
): DiagnosticRequest => {
  const request: DiagnosticRequest = {
    account_id: target.account_id,
    hostname: target.hostname,
    checks: target.acme_challenge_token
      ? [...DEFAULT_DIAGNOSTIC_CHECKS, 'acme_challenge']
      : [...DEFAULT_DIAGNOSTIC_CHECKS],
    ports: [...HOSTNAME_LISTENER_PORTS],
  };
  if (target.expected_public_ip !== undefined) {
    request.expected_public_ip = target.expected_public_ip;
  }
  if (target.acme_challenge_token !== undefined) {
    request.acme_challenge_token = target.acme_challenge_token;
  }
  if (target.ownership_probe_method !== undefined) {
    request.ownership_probe_method = target.ownership_probe_method;
  }
  return request;
};

export type ReachabilityExternalProbeTargetOverride =
  Partial<Omit<ReachabilityDiagnosticTarget, 'account_id'>>;

export type ReachabilityExternalProbeCaller = (
  override?: ReachabilityExternalProbeTargetOverride,
) => Promise<DiagnosticResponse>;

export interface CreateReachabilityDiagnosticProbeCallerOptions {
  resolveTarget: () => Promise<ReachabilityDiagnosticTarget>;
  fetcher?: FetchLike;
  baseUrl?: string;
}

export const createReachabilityDiagnosticProbeCaller = (
  opts: CreateReachabilityDiagnosticProbeCallerOptions,
): ReachabilityExternalProbeCaller =>
  async (override) => {
    const fetcher = opts.fetcher ?? defaultFetch;
    const baseTarget = await opts.resolveTarget();
    const target: ReachabilityDiagnosticTarget = {
      ...baseTarget,
      ...override,
    };
    const request = buildReachabilityDiagnosticRequest(target);
    const res = await fetcher(
      diagnosticProbeUrl(opts.baseUrl ?? DEFAULT_DIAGNOSTIC_API_BASE_URL),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      throw new Error(apiErrorMessage(body, res.status));
    }
    return readApiData<DiagnosticResponse>(body);
  };

export const diagnosticResponseHasReachablePort = (
  response: DiagnosticResponse,
  port: number,
): boolean =>
  response.results.some((result) =>
    result.kind === 'port_reachability'
    && result.status === 'pass'
    && result.payload.kind === 'port_reachability'
    && result.payload.port === port
    && result.payload.outcome === 'reachable',
  );

export const diagnosticResponseHasHostnameMatchedTls = (
  response: DiagnosticResponse,
): boolean =>
  response.results.some((result) =>
    result.kind === 'tls_handshake'
    && result.status === 'pass'
    && result.payload.kind === 'tls_handshake'
    && result.payload.cert_valid
    && result.payload.cert_matches_hostname,
  );

export const diagnosticResponseShowsReachableUrl = (
  response: DiagnosticResponse | null | undefined,
  hostname: string,
  port: number,
): boolean => {
  if (response === null || response === undefined) return false;
  if (response.hostname !== hostname) return false;
  if (!diagnosticResponseHasReachablePort(response, port)) return false;
  return port === 443 ? diagnosticResponseHasHostnameMatchedTls(response) : true;
};

export type ReachabilityProbeStatus = 'idle' | 'running' | 'success' | 'error';

export interface ReachabilityProbePanelState {
  status: ReachabilityProbeStatus;
  response: DiagnosticResponse | null;
  error: string | null;
}

export interface MountReachabilityPanelOptions {
  host: HTMLElement;
  report?: ReachabilityReport;
  runExternalProbe?: ReachabilityExternalProbeCaller;
  canRunExternalProbe?: boolean;
  now?: () => number;
}

export interface ReachabilityPanelMount {
  getState(): ReachabilityProbePanelState;
  runExternalProbe(): Promise<void>;
  updateReport(report: ReachabilityReport): void;
  whenProbeSettled(): Promise<void>;
  dispose(): void;
}

const computeBadge = (
  errors: number,
  warnings: number,
): 'healthy' | 'attention' | 'critical' => {
  if (errors > 0) return 'critical';
  if (warnings > 0) return 'attention';
  return 'healthy';
};

const shortFingerprint = (full: string): string => {
  if (full.length <= 12) return full;
  return `${full.slice(0, 8)}…${full.slice(-4)}`;
};

const buildRecommendation = (
  rec: ReachabilityRecommendation,
): ReachabilityRenderModel['recommendations'][number] => ({
  severity: rec.severity,
  code: rec.code,
  message: rec.message,
  remediation: rec.remediation ?? REMEDIATION_COPY[rec.code] ?? '',
});

const sortRecommendationsForDisplay = (
  recs: ReachabilityRecommendation[],
): ReachabilityRecommendation[] => {
  const order: Record<ReachabilityRecommendation['severity'], number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  return [...recs].sort((a, b) => {
    const sa = order[a.severity];
    const sb = order[b.severity];
    if (sa !== sb) return sa - sb;
    return a.code.localeCompare(b.code);
  });
};

/** Build the render model from a `ReachabilityReport`. Pure
 *  projection — no IO. Caller refetches when the rpc reports a
 *  newer `report_id`. */
export const buildReachabilityRenderModel = (
  report: ReachabilityReport,
  options: { can_run_cloud_probe?: boolean } = {},
): ReachabilityRenderModel => {
  const recs = sortRecommendationsForDisplay(report.recommendations);
  const error_count = recs.filter((r) => r.severity === 'error').length;
  const warning_count = recs.filter((r) => r.severity === 'warning').length;
  const info_count = recs.filter((r) => r.severity === 'info').length;
  return {
    severity_summary: {
      error_count,
      warning_count,
      info_count,
      badge: computeBadge(error_count, warning_count),
    },
    network_summary: {
      public_ip: report.network.public_ipv4 ?? report.network.public_ipv6 ?? null,
      behind_nat: report.network.behind_nat,
      handle: report.dns.handle ?? null,
      handle_resolves: report.dns.ddns_resolves,
      handle_resolves_to_expected_ip: report.dns.resolved_to_expected_ip,
    },
    tls_summary: {
      fingerprint_short: shortFingerprint(report.tls.cert_fingerprint),
      days_until_expiry: report.tls.days_until_expiry,
      issuer: report.tls.issuer,
      valid_for_handle: report.tls.valid_for_handle,
    },
    per_path: report.per_path,
    per_domain_tls: report.per_domain_tls ?? [],
    webhooks: report.webhooks,
    bridges: report.bridges,
    webclients: report.webclients,
    recommendations: recs.map(buildRecommendation),
    can_run_cloud_probe: options.can_run_cloud_probe ?? true,
  };
};

const statusLabel = (status: DiagnosticResult['status']): string =>
  status === 'pass' ? 'Pass' : status === 'warn' ? 'Warn' : 'Fail';

const formatDiagnosticKind = (kind: DiagnosticKind): string =>
  kind
    .split('_')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');

const formatDiagnosticPayload = (result: DiagnosticResult): string => {
  const payload = result.payload;
  switch (payload.kind) {
    case 'detected_public_ip':
      return payload.ip
        ? `${payload.ip}${payload.ip_version ? ` (IPv${payload.ip_version})` : ''}`
        : 'Recued saw no public address';
    case 'port_reachability':
      return `Port ${payload.port}: ${payload.outcome}${
        payload.latency_ms !== undefined ? ` (${payload.latency_ms} ms)` : ''
      }`;
    case 'dns_resolution':
      return `${payload.resolved_ips.length > 0 ? payload.resolved_ips.join(', ') : 'No records'}; ${
        payload.matches_expected_ip ? 'matches the address Recued expected' : 'does not match the address Recued expected'
      }`;
    case 'tls_handshake':
      return `cert ${
        payload.cert_valid ? 'valid' : 'invalid'
      }, hostname ${payload.cert_matches_hostname ? 'matches' : 'mismatch'}${
        payload.cert_issuer ? `, ${payload.cert_issuer}` : ''
      }`;
    case 'acme_challenge':
      return `HTTP-01 ${payload.well_known_reachable ? 'reachable' : 'unreachable'}${
        payload.status_code !== undefined ? ` (${payload.status_code})` : ''
      }`;
    case 'nat_class':
      return payload.class;
  }
};

const renderExternalProbeResults = (
  state: ReachabilityProbePanelState,
): string => {
  if (state.error) {
    return `<p class="reachability-error" ${REACHABILITY_PROBE_ERROR_ATTR}>${escapeHtml(
      state.error,
    )}</p>`;
  }
  if (state.response === null) {
    if (state.status === 'running') {
      return '<p class="reachability-muted">External probe running...</p>';
    }
    return '';
  }
  const counts = state.response.results.reduce(
    (acc, result) => {
      acc[result.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
  const rows = state.response.results
    .map((result) => `
      <tr>
        <td>${escapeHtml(formatDiagnosticKind(result.kind))}</td>
        <td><span class="reachability-status reachability-status-${result.status}">${statusLabel(result.status)}</span></td>
        <td>${escapeHtml(formatDiagnosticPayload(result))}</td>
        <td>${escapeHtml(result.remediation_hint ?? '')}</td>
      </tr>`)
    .join('');
  return `
    <div class="reachability-probe-results" ${REACHABILITY_PROBE_RESULTS_ATTR}>
      <p class="reachability-muted">External probe for ${escapeHtml(state.response.hostname)}: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail</p>
      <table class="reachability-probe-table">
        <thead>
          <tr>
            <th>Check</th>
            <th>Status</th>
            <th>Result</th>
            <th>Remediation</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
};

const renderReachabilityPanel = (
  report: ReachabilityReport | null,
  state: ReachabilityProbePanelState,
  canRunExternalProbe: boolean,
  hasCaller: boolean,
): string => {
  const model = report ? buildReachabilityRenderModel(report) : null;
  const disabled =
    state.status === 'running' || !canRunExternalProbe || !hasCaller
      ? ' disabled'
      : '';
  const badge = model
    ? `<span class="reachability-badge reachability-badge-${model.severity_summary.badge}">${escapeHtml(model.severity_summary.badge)}</span>`
    : '';
  const summary = model
    ? `<dl class="reachability-summary">
        <div><dt>Hostname</dt><dd>${escapeHtml(model.network_summary.handle ?? 'Not set up')}</dd></div>
        <div><dt>Public IP</dt><dd>${escapeHtml(model.network_summary.public_ip ?? 'Unknown')}</dd></div>
        <div><dt>TLS</dt><dd>${escapeHtml(model.tls_summary.issuer)} / ${model.tls_summary.days_until_expiry} day(s)</dd></div>
      </dl>`
    : '<p class="reachability-muted">External diagnostics target the paired server hostname.</p>';
  return `
    <div class="reachability-panel" ${REACHABILITY_PANEL_ATTR}>
      <div class="reachability-header">
        <h3>Reachability Doctor</h3>
        ${badge}
      </div>
      ${summary}
      <div class="reachability-actions">
        <button
          type="button"
          class="rx-btn rx-btn-secondary"
          data-action="${RUN_EXTERNAL_PROBE_ACTION}"
          ${REACHABILITY_RUN_EXTERNAL_PROBE_BTN_ATTR}
          ${disabled}
        >${state.status === 'running' ? 'Running...' : 'Check from the outside'}</button>
      </div>
      ${renderExternalProbeResults(state)}
    </div>`;
};

export const mountReachabilityPanel = (
  opts: MountReachabilityPanelOptions,
): ReachabilityPanelMount => {
  let report: ReachabilityReport | null = opts.report ?? null;
  let state: ReachabilityProbePanelState = {
    status: 'idle',
    response: null,
    error: null,
  };
  let disposed = false;
  let pendingProbe: Promise<void> | null = null;

  opts.host.setAttribute(REACHABILITY_PANEL_ATTR, '');

  const render = (): void => {
    if (disposed) return;
    const canRunExternalProbe =
      opts.canRunExternalProbe ?? (report ? buildReachabilityRenderModel(report).can_run_cloud_probe : true);
    opts.host.innerHTML = renderReachabilityPanel(
      report,
      state,
      canRunExternalProbe,
      opts.runExternalProbe !== undefined,
    );
  };

  const setState = (patch: Partial<ReachabilityProbePanelState>): void => {
    if (disposed) return;
    state = { ...state, ...patch };
    render();
  };

  const runExternalProbe = async (): Promise<void> => {
    if (disposed) return;
    if (!opts.runExternalProbe) return;
    const canRunExternalProbe =
      opts.canRunExternalProbe ?? (report ? buildReachabilityRenderModel(report).can_run_cloud_probe : true);
    if (!canRunExternalProbe) return;
    setState({ status: 'running', error: null });
    try {
      const response = await opts.runExternalProbe();
      setState({ status: 'success', response, error: null });
    } catch (err) {
      setState({ status: 'error', error: errorMessage(err) });
    }
  };

  const onClick = (ev: Event): void => {
    if (disposed) return;
    const target = ev.target as
      | (HTMLElement & { closest?: (selector: string) => HTMLElement | null })
      | null;
    if (!target?.closest) return;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (actionEl?.getAttribute('data-action') !== RUN_EXTERNAL_PROBE_ACTION) return;
    if (state.status === 'running') return;
    pendingProbe = runExternalProbe();
  };

  opts.host.addEventListener('click', onClick);
  render();

  return {
    getState: () => state,
    runExternalProbe: () => {
      pendingProbe = runExternalProbe();
      return pendingProbe;
    },
    updateReport: (nextReport) => {
      report = nextReport;
      render();
    },
    whenProbeSettled: () => pendingProbe ?? Promise.resolve(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      opts.host.removeEventListener('click', onClick);
      opts.host.innerHTML = '';
      opts.host.removeAttribute(REACHABILITY_PANEL_ATTR);
    },
  };
};

export const REACHABILITY_PANEL_STYLES = `
.reachability-panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--surface);
}
.reachability-header,
.reachability-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.reachability-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.reachability-summary {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.reachability-summary div {
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 8px;
  background: var(--surface);
}
.reachability-summary dt {
  margin: 0 0 3px;
  color: var(--muted);
  font-size: 11px;
}
.reachability-summary dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.reachability-badge,
.reachability-status {
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
}
.reachability-badge-healthy,
.reachability-status-pass {
  background: var(--ok-bg);
  color: var(--ok-fg);
}
.reachability-badge-attention,
.reachability-status-warn {
  background: var(--warn-bg);
  color: var(--warn);
}
.reachability-badge-critical,
.reachability-status-fail,
.reachability-error {
  background: var(--danger-bg);
  color: var(--danger);
}
.reachability-muted,
.reachability-error {
  margin: 0;
  line-height: 1.45;
}
.reachability-muted {
  color: var(--muted);
}
.reachability-error {
  border-radius: 6px;
  padding: 8px;
}
.reachability-probe-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.reachability-probe-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.reachability-probe-table th,
.reachability-probe-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: top;
}
.reachability-probe-table th {
  color: var(--muted);
  font-weight: 600;
}
@media (max-width: 640px) {
  .reachability-summary {
    grid-template-columns: 1fr;
  }
}
`;
