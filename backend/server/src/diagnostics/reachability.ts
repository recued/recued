/** D-148 § A.10 — Reachability Doctor (Amendment 2026-05-11; W3.5 path-routed).
 *
 *  Self-service diagnostic that renders the resolved network state of
 *  the user's server: NAT topology, DDNS resolution, cert health,
 *  per-path handshake results, per-vendor webhook health, paired
 *  bridge / webclient state, and a closed-list recommendation feed.
 *
 *  Path-routing amendment: per-port `ListenerStatus` rows from the
 *  legacy 4-port `createListenerSet` retire; the doctor now consumes
 *  `PathListenerStatus[]` from `createPathListenerSet` and renders
 *  per-path entries (one row per `PathRole`, lan_listening +
 *  public_listening + handshake outcome).
 *
 *  Caller passes input blocks synchronously + the doctor assembles the
 *  report. When the user clicks "Run external probe" in the doctor,
 *  the caller passes a non-null `cloud_probe` block + the doctor merges
 *  it into the per-path block + appends a
 *  `path_unreachable_from_cloud` recommendation for any path the cloud
 *  probe couldn't reach. */

import {
  PATH_ROLES,
  type CloudProbeResponse,
  type PathRole,
  type ReachabilityBridgeEntry,
  type ReachabilityDnsBlock,
  type ReachabilityHmacTest,
  type ReachabilityNetworkBlock,
  type ReachabilityPathEntry,
  type ReachabilityPerDomainTlsEntry,
  type ReachabilityRecommendation,
  type ReachabilityRecommendationCode,
  type ReachabilityReport,
  type ReachabilityTlsBlock,
  type ReachabilityWebclientEntry,
  type ReachabilityWebhookEntry,
} from '@recued/contracts';
import type { PathListenerStatus } from '@recued/server-tls';
import {
  buildPerDomainTlsHealth,
  type PerDomainTlsHealthInput,
} from './per-domain-tls-health.js';

/** Caller-side block builders. Each returns the block synchronously
 *  + the doctor merges them — no IO inside the doctor itself. */
export interface ReachabilityInputs {
  report_id: string;
  generated_at: number;
  server_passport_fingerprint: string;
  network: ReachabilityNetworkBlock;
  dns: ReachabilityDnsBlock;
  tls: ReachabilityTlsBlock;
  /** Path-listener-set status snapshot — two rows (lan + public).
   *  Combined with the per-path `resolution` to surface one
   *  `ReachabilityPathEntry` per `PathRole`. */
  listeners: PathListenerStatus[];
  /** Per-path resolution map from the live ExposureState. Drives
   *  which `PathRole`s receive `lan_listening` / `public_listening`
   *  true bits. */
  path_resolution: Record<PathRole, { lan: boolean; public: boolean }>;
  /** Per-vendor webhook health rows. Empty when no vendors are
   *  configured. */
  webhooks: WebhookHealthInput[];
  /** Paired bridges + webclients online state — merged from the
   *  WS-server's `listConnectedClients` view. */
  bridges: ReachabilityBridgeEntry[];
  webclients: ReachabilityWebclientEntry[];
  /** Optional cloud-probe block. When present, the doctor merges
   *  per-path results into `per_path` + emits a
   *  `path_unreachable_from_cloud` recommendation per failing
   *  path. */
  cloud_probe?: CloudProbeResponse;
  /** D-148 FU2 — pre-verified per-domain TLS health rows. The caller
   *  (eventually bin.ts after the doctor rpc wires) builds these by
   *  walking `SqliteTlsDomainStore.listForHealthCheck()` + applying
   *  the verifier seam via `verifyDomainHealth`. When present + non-
   *  empty, the doctor emits a `per_domain_tls` entry per row + adds
   *  per-domain expiry / chain / fingerprint recommendations to the
   *  main `recommendations` feed. */
  per_domain_tls?: PerDomainTlsHealthInput[];
}

/** Inbound webhook health row before the doctor lifts to the public
 *  block. The substrate caller computes `last_inbound_at` /
 *  `last_failed_at` from the per-vendor inbound ledger. */
export interface WebhookHealthInput {
  integration: string;
  configured: boolean;
  last_inbound_at?: number;
  last_failed_at?: number;
  hmac_test: ReachabilityHmacTest;
}

/** Window before cert expiry where the doctor flags the renewal as
 *  imminent (`tls_renewal_imminent`) — 14 days. */
export const TLS_RENEWAL_IMMINENT_WINDOW_DAYS = 14;
/** Window before cert expiry where the doctor flags the renewal as
 *  overdue (`tls_renewal_overdue`) — 7 days. */
export const TLS_RENEWAL_OVERDUE_WINDOW_DAYS = 7;
/** Maximum age of the last_inbound_at signal before the doctor flags
 *  `webhook_inbound_silent` — 7 days. */
export const WEBHOOK_SILENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const buildPathEntries = (
  inputs: ReachabilityInputs,
): { entries: ReachabilityPathEntry[]; cloud_failures: PathRole[] } => {
  const lanStatus = inputs.listeners.find((s) => s.listener === 'lan');
  const publicStatus = inputs.listeners.find((s) => s.listener === 'public');
  const cloud_failures: PathRole[] = [];
  // D-176 Phase 5 — the cloud probe now returns port-shaped `per_target`
  // results; fold the role-tagged ones into a per-PathRole reachability bit.
  // A role can carry MORE than one target (e.g. a tcp + an http check both
  // tagged `mcp`), so aggregate with AND: the role is reachable-from-cloud
  // only if EVERY same-role target was reachable — otherwise one failed check
  // would be hidden by a later passing one.
  const cloudReachableByRole = new Map<PathRole, boolean>();
  for (const t of inputs.cloud_probe?.per_target ?? []) {
    if (!t.role) continue;
    cloudReachableByRole.set(t.role, (cloudReachableByRole.get(t.role) ?? true) && t.reachable);
  }
  const lanFailure = lanStatus?.failure;
  const publicFailure = publicStatus?.failure;
  const entries: ReachabilityPathEntry[] = PATH_ROLES.map((role) => {
    const res = inputs.path_resolution[role];
    const lan_listening = !!(res.lan && lanStatus?.listening);
    const public_listening = !!(res.public && publicStatus?.listening);
    const cloud_probe_reachable = cloudReachableByRole.get(role);
    if (cloud_probe_reachable === false && res.public) {
      cloud_failures.push(role);
    }
    // Handshake test reflects the underlying listener bind result —
    // if the role wants public but the public listener failed, the
    // role's handshake fails too.
    const handshakePassed = (
      (res.lan ? !!lanStatus?.listening && !lanFailure : true)
      && (res.public ? !!publicStatus?.listening && !publicFailure : true)
    );
    const handshakeError = res.public && publicFailure
      ? publicFailure
      : res.lan && lanFailure
      ? lanFailure
      : undefined;
    const entry: ReachabilityPathEntry = {
      role,
      lan_listening,
      public_listening,
      handshake_test: {
        passed: handshakePassed,
        ms: 0,
        ...(handshakeError ? { error: handshakeError } : {}),
      },
    };
    if (cloud_probe_reachable !== undefined) entry.cloud_probe_reachable = cloud_probe_reachable;
    return entry;
  });
  return { entries, cloud_failures };
};

const buildRecommendations = (
  inputs: ReachabilityInputs,
  path_entries: ReachabilityPathEntry[],
  cloud_failures: PathRole[],
): ReachabilityRecommendation[] => {
  const out: ReachabilityRecommendation[] = [];
  const tls = inputs.tls;
  const dns = inputs.dns;

  // TLS expiry windows.
  if (tls.renewal_overdue || tls.days_until_expiry <= TLS_RENEWAL_OVERDUE_WINDOW_DAYS) {
    out.push({
      severity: 'error',
      code: 'tls_renewal_overdue',
      message: `TLS cert expires in ${tls.days_until_expiry} day(s)`,
      remediation: 'Trigger an ACME renewal via Settings → Server → Key Health → Renew TLS.',
    });
  } else if (tls.days_until_expiry <= TLS_RENEWAL_IMMINENT_WINDOW_DAYS) {
    out.push({
      severity: 'warning',
      code: 'tls_renewal_imminent',
      message: `TLS cert expires in ${tls.days_until_expiry} day(s)`,
    });
  }

  // DDNS resolution mismatch.
  if (dns.handle && dns.ddns_resolves && !dns.resolved_to_expected_ip) {
    out.push({
      severity: 'error',
      code: 'ddns_ip_mismatch',
      message: `DNS for handle '${dns.handle}' does not resolve to the expected IP`,
      remediation: 'Trigger a DDNS refresh via Settings → Server → DDNS → Refresh.',
    });
  }

  // Webhook silence + HMAC failure.
  for (const webhook of inputs.webhooks) {
    if (!webhook.configured) continue;
    if (webhook.hmac_test.passed === false) {
      const rec: ReachabilityRecommendation = {
        severity: 'error',
        code: 'webhook_hmac_failure',
        message: `${webhook.integration} HMAC verification failed`,
      };
      if (webhook.hmac_test.error) {
        rec.remediation = `Last error: ${webhook.hmac_test.error}`;
      }
      out.push(rec);
    } else if (
      webhook.last_inbound_at &&
      inputs.generated_at - webhook.last_inbound_at > WEBHOOK_SILENCE_WINDOW_MS
    ) {
      out.push({
        severity: 'warning',
        code: 'webhook_inbound_silent',
        message: `${webhook.integration} webhook has been silent for >7 days`,
        remediation: 'Verify port-forwarding + signing secret in Settings → Connections.',
      });
    }
  }

  // Bridge offline.
  for (const bridge of inputs.bridges) {
    if (!bridge.online) {
      out.push({
        severity: 'warning',
        code: 'bridge_offline',
        message: `Bridge '${bridge.client_label ?? 'unnamed'}' is offline`,
      });
    }
  }

  // Per-path cloud-probe failures.
  for (const role of cloud_failures) {
    out.push({
      severity: 'error',
      code: 'path_unreachable_from_cloud',
      message: `Path '${role}' was not reachable from the cloud probe`,
      remediation:
        `Check NAT / port-forwarding for the public listener. LAN-only? Switch to a preset that includes /${role} in the public column.`,
    });
  }

  // NAT traversal hint when the user has any public path + UPnP is
  // unsupported.
  const any_public = path_entries.some((p) => p.public_listening);
  if (any_public && inputs.network.upnp_status === 'unsupported') {
    out.push({
      severity: 'info',
      code: 'nat_traversal_required',
      message: 'UPnP unavailable on this network — manual port-forwarding may be required.',
    });
  }

  // Cert fingerprint mismatch — if any cloud-probe entry surfaced a
  // cert fingerprint that disagrees with the local TLS block.
  if (inputs.cloud_probe) {
    for (const row of inputs.cloud_probe.per_target) {
      if (row.cert_fingerprint && tls.cert_fingerprint && row.cert_fingerprint !== tls.cert_fingerprint) {
        const where = row.role ? `'${row.role}'` : `port ${row.port}`;
        out.push({
          severity: 'error',
          code: 'cert_fingerprint_mismatch',
          message: `Cloud-probe observed a different TLS cert on ${where} than this server holds — possible MITM`,
        });
        // One mismatch is enough — additional targets likely report the
        // same delta.
        break;
      }
    }
  }

  return out;
};

const buildWebhookEntries = (
  inputs: ReachabilityInputs,
): ReachabilityWebhookEntry[] => {
  return inputs.webhooks.map((w) => {
    const entry: ReachabilityWebhookEntry = {
      integration: w.integration,
      configured: w.configured,
      hmac_test: w.hmac_test,
    };
    if (w.last_inbound_at !== undefined) entry.last_inbound_at = w.last_inbound_at;
    if (w.last_failed_at !== undefined) entry.last_failed_at = w.last_failed_at;
    return entry;
  });
};

/** Build the full Reachability Doctor report from the supplied
 *  inputs. Pure assembly — no IO. */
export const buildReachabilityReport = (
  inputs: ReachabilityInputs,
): ReachabilityReport => {
  const { entries: per_path, cloud_failures } = buildPathEntries(inputs);
  // D-148 FU2 — per-domain TLS health rollup. Builds entries +
  // per-domain recommendations from the pre-verified input rows.
  // Skipped entirely when the input is undefined or empty (the
  // server has no per-domain certs configured).
  const perDomainResult = inputs.per_domain_tls && inputs.per_domain_tls.length > 0
    ? buildPerDomainTlsHealth(inputs.per_domain_tls, { now_ms: inputs.generated_at })
    : null;
  const recommendations = buildRecommendations(inputs, per_path, cloud_failures);
  if (perDomainResult) {
    recommendations.push(...perDomainResult.recommendations);
  }
  const report: ReachabilityReport = {
    report_id: inputs.report_id,
    generated_at: inputs.generated_at,
    server_passport_fingerprint: inputs.server_passport_fingerprint,
    network: inputs.network,
    dns: inputs.dns,
    tls: inputs.tls,
    per_path,
    webhooks: buildWebhookEntries(inputs),
    bridges: inputs.bridges,
    webclients: inputs.webclients,
    recommendations,
  };
  if (perDomainResult) {
    report.per_domain_tls = perDomainResult.entries;
  }
  return report;
};

/** Helper — order recommendations by severity (error first). The
 *  webclient renderer reuses this so the UI ordering matches the
 *  rpc output. */
export const sortRecommendations = (
  recommendations: ReachabilityRecommendation[],
): ReachabilityRecommendation[] => {
  const order: Record<ReachabilityRecommendation['severity'], number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  return [...recommendations].sort((a, b) => {
    const sa = order[a.severity];
    const sb = order[b.severity];
    if (sa !== sb) return sa - sb;
    return a.code.localeCompare(b.code);
  });
};

/** Closed-list of all the recommendation codes the doctor can emit.
 *  Re-exported so the webclient can build its remediation lookup
 *  table off the canonical list. */
export const REACHABILITY_RECOMMENDATION_CODES_USED: ReadonlyArray<ReachabilityRecommendationCode> = [
  'tls_renewal_overdue',
  'tls_renewal_imminent',
  'ddns_ip_mismatch',
  'webhook_inbound_silent',
  'webhook_hmac_failure',
  'bridge_offline',
  'cert_fingerprint_mismatch',
  'path_unreachable_from_cloud',
  'nat_traversal_required',
  'exposure_resolution_inconsistent',
  'reception_listener_silent',
  'reception_endpoint_unreachable',
  'reception_cert_san_missing_hostname',
  'tls_chain_invalid_for_domain',
];
