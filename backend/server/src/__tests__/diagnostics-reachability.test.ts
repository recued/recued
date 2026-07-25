/** D-148 W3.5 — Reachability Doctor: per-path report assembly + recommendations. */

import { describe, expect, it } from 'vitest';
import {
  type CloudProbeResponse,
  type PathResolution,
  type PathRole,
  type ReachabilityBridgeEntry,
  type ReachabilityDnsBlock,
  type ReachabilityNetworkBlock,
  type ReachabilityTlsBlock,
  type ReachabilityWebclientEntry,
} from '@recued/contracts';
import type { PathListenerStatus } from '@recued/server-tls';
import {
  buildReachabilityReport,
  sortRecommendations,
  TLS_RENEWAL_IMMINENT_WINDOW_DAYS,
  TLS_RENEWAL_OVERDUE_WINDOW_DAYS,
  WEBHOOK_SILENCE_WINDOW_MS,
  type ReachabilityInputs,
  type WebhookHealthInput,
} from '../diagnostics/reachability.js';

const NETWORK: ReachabilityNetworkBlock = {
  public_ipv4: '203.0.113.5',
  detected_via: 'cloud_probe',
  behind_nat: false,
  upnp_status: 'enabled',
};

const HEALTHY_DNS: ReachabilityDnsBlock = {
  handle: 'alice',
  ddns_resolves: true,
  resolved_to_expected_ip: true,
  resolution_ms: 50,
  last_ddns_update: 1_700_000_000_000,
};

const HEALTHY_TLS: ReachabilityTlsBlock = {
  cert_fingerprint: 'a'.repeat(64),
  expires_at: Date.now() + 60 * 24 * 60 * 60 * 1000,
  days_until_expiry: 60,
  issuer: "Let's Encrypt",
  san: ['alice.recued.cloud'],
  valid_for_handle: true,
  renewal_overdue: false,
};

// Public resolution: every path enabled on both listeners (matches the
// `public` preset shape, with /mcp.public off as the default ack-less
// baseline).
const PUBLIC_RESOLUTION: Record<PathRole, PathResolution> = {
  health: { lan: true, public: true },
  ws: { lan: true, public: true },
  mcp: { lan: true, public: false },
  llm_gateway: { lan: true, public: true },
  webhooks: { lan: true, public: true },
  reception: { lan: true, public: true },
  oauth: { lan: false, public: false },
  ask: { lan: false, public: false },
  webclient: { lan: true, public: false },
};

const LISTENERS: PathListenerStatus[] = [
  { listener: 'lan', port: 80, listening: true, bind_address: '192.168.1.42', tls: false },
  { listener: 'public', port: 443, listening: true, bind_address: '0.0.0.0', tls: true },
];

const buildBridges = (online = true): ReachabilityBridgeEntry[] => [
  {
    online,
    last_seen_at: 1_700_000_000_000,
    capabilities: {
      software_version: '1.0.0',
      chrome_version: '120',
      permissions_granted: [],
      granted_origins: [],
      offscreen_supported: true,
      alarms_supported: true,
    },
    client_label: 'work-laptop',
  },
];

const buildWebclients = (online = true): ReachabilityWebclientEntry[] => [{
  online,
  last_seen_at: 1_700_000_000_000,
  client_label: 'phone',
}];

const buildInputs = (overrides: Partial<ReachabilityInputs> = {}): ReachabilityInputs => ({
  report_id: 'r-1',
  generated_at: Date.now(),
  server_passport_fingerprint: 'fp',
  network: NETWORK,
  dns: HEALTHY_DNS,
  tls: HEALTHY_TLS,
  listeners: LISTENERS,
  path_resolution: PUBLIC_RESOLUTION,
  webhooks: [],
  bridges: buildBridges(),
  webclients: buildWebclients(),
  ...overrides,
});

describe('buildReachabilityReport — happy path', () => {
  it('builds the full report shape with no recommendations on a healthy server', () => {
    const report = buildReachabilityReport(buildInputs());
    expect(report.report_id).toBe('r-1');
    expect(report.recommendations).toEqual([]);
    expect(report.per_path).toHaveLength(9);
    expect(report.per_path.find((p) => p.role === 'ws')?.handshake_test.passed).toBe(true);
  });

  it('every per-path entry includes role + lan_listening + public_listening', () => {
    const report = buildReachabilityReport(buildInputs());
    for (const entry of report.per_path) {
      expect([
        'health',
        'ws',
        'mcp',
        'llm_gateway',
        'webhooks',
        'reception',
        'oauth',
        'ask',
        'webclient',
      ]).toContain(entry.role);
      expect(typeof entry.lan_listening).toBe('boolean');
      expect(typeof entry.public_listening).toBe('boolean');
    }
  });
});

describe('buildReachabilityReport — TLS recommendations', () => {
  it('emits tls_renewal_overdue when expiry is within the overdue window', () => {
    const tls: ReachabilityTlsBlock = {
      ...HEALTHY_TLS,
      days_until_expiry: TLS_RENEWAL_OVERDUE_WINDOW_DAYS - 1,
      renewal_overdue: false,
    };
    const report = buildReachabilityReport(buildInputs({ tls }));
    const overdue = report.recommendations.find((r) => r.code === 'tls_renewal_overdue');
    expect(overdue?.severity).toBe('error');
    expect(overdue?.message).toContain('day(s)');
  });

  it('emits tls_renewal_imminent within the imminent window but past overdue', () => {
    const tls: ReachabilityTlsBlock = {
      ...HEALTHY_TLS,
      days_until_expiry: TLS_RENEWAL_IMMINENT_WINDOW_DAYS - 1,
      renewal_overdue: false,
    };
    const report = buildReachabilityReport(buildInputs({ tls }));
    const codes = report.recommendations.map((r) => r.code);
    expect(codes).toContain('tls_renewal_imminent');
    expect(codes).not.toContain('tls_renewal_overdue');
  });

  it('respects the renewal_overdue flag even when days_until_expiry is high', () => {
    const tls: ReachabilityTlsBlock = {
      ...HEALTHY_TLS,
      days_until_expiry: 30,
      renewal_overdue: true,
    };
    const report = buildReachabilityReport(buildInputs({ tls }));
    expect(report.recommendations.some((r) => r.code === 'tls_renewal_overdue')).toBe(true);
  });
});

describe('buildReachabilityReport — DDNS recommendation', () => {
  it('emits ddns_ip_mismatch when handle resolves but to wrong IP', () => {
    const dns: ReachabilityDnsBlock = {
      ...HEALTHY_DNS,
      resolved_to_expected_ip: false,
    };
    const report = buildReachabilityReport(buildInputs({ dns }));
    expect(report.recommendations.some((r) => r.code === 'ddns_ip_mismatch')).toBe(true);
  });
});

describe('buildReachabilityReport — webhook health', () => {
  it('emits webhook_hmac_failure when hmac_test reports a failure', () => {
    const webhooks: WebhookHealthInput[] = [{
      integration: 'hubspot',
      configured: true,
      hmac_test: { passed: false, error: 'signature_invalid' },
    }];
    const report = buildReachabilityReport(buildInputs({ webhooks }));
    const rec = report.recommendations.find((r) => r.code === 'webhook_hmac_failure');
    expect(rec?.severity).toBe('error');
    expect(rec?.remediation).toContain('signature_invalid');
  });

  it('emits webhook_inbound_silent when last_inbound_at is older than the window', () => {
    const generated_at = 100 * WEBHOOK_SILENCE_WINDOW_MS;
    const webhooks: WebhookHealthInput[] = [{
      integration: 'hubspot',
      configured: true,
      last_inbound_at: 50 * WEBHOOK_SILENCE_WINDOW_MS,
      hmac_test: { passed: true },
    }];
    const report = buildReachabilityReport(buildInputs({ webhooks, generated_at }));
    expect(report.recommendations.some((r) => r.code === 'webhook_inbound_silent')).toBe(true);
  });

  it('skips webhook recommendations when the webhook is not configured', () => {
    const webhooks: WebhookHealthInput[] = [{
      integration: 'slack',
      configured: false,
      hmac_test: { passed: false },
    }];
    const report = buildReachabilityReport(buildInputs({ webhooks }));
    expect(report.recommendations.find((r) => r.code === 'webhook_hmac_failure')).toBeUndefined();
  });
});

describe('buildReachabilityReport — bridge offline', () => {
  it('emits bridge_offline for each disconnected bridge', () => {
    const bridges: ReachabilityBridgeEntry[] = buildBridges(false);
    const report = buildReachabilityReport(buildInputs({ bridges }));
    expect(report.recommendations.some((r) => r.code === 'bridge_offline')).toBe(true);
  });
});

describe('buildReachabilityReport — cloud probe integration', () => {
  it('merges cloud_probe_reachable into per_path', () => {
    const cloud_probe: CloudProbeResponse = {
      hostname: 'alice.recued.cloud',
      resolved_ip: '203.0.113.5',
      per_target: [
        { port: 443, kind: 'tls', role: 'ws', reachable: true, tls_valid: true, cert_fingerprint: 'a'.repeat(64), cert_expires_at: 0, handshake_ms: 100 },
        { port: 443, kind: 'tls', role: 'webhooks', reachable: true, tls_valid: true, cert_fingerprint: 'a'.repeat(64), cert_expires_at: 0, handshake_ms: 90 },
        { port: 443, kind: 'tls', role: 'mcp', reachable: false, tls_valid: false, cert_fingerprint: null, cert_expires_at: null, handshake_ms: 0 },
        { port: 443, kind: 'tls', role: 'reception', reachable: true, tls_valid: true, cert_fingerprint: 'a'.repeat(64), cert_expires_at: 0, handshake_ms: 80 },
      ],
      recommendations: [],
      probed_at: 1_700_000_000_000,
    };
    const report = buildReachabilityReport(buildInputs({ cloud_probe }));
    const ws_entry = report.per_path.find((p) => p.role === 'ws');
    expect(ws_entry?.cloud_probe_reachable).toBe(true);
    const mcp_entry = report.per_path.find((p) => p.role === 'mcp');
    expect(mcp_entry?.cloud_probe_reachable).toBe(false);
  });

  it('emits path_unreachable_from_cloud when a public path is unreachable from cloud', () => {
    const cloud_probe: CloudProbeResponse = {
      hostname: 'alice.recued.cloud',
      resolved_ip: '203.0.113.5',
      per_target: [
        { port: 443, kind: 'tls', role: 'ws', reachable: false, tls_valid: false, cert_fingerprint: null, cert_expires_at: null, handshake_ms: 0 },
      ],
      recommendations: [],
      probed_at: 1_700_000_000_000,
    };
    const report = buildReachabilityReport(buildInputs({ cloud_probe }));
    expect(report.recommendations.some((r) => r.code === 'path_unreachable_from_cloud')).toBe(true);
  });

  it('does NOT emit path_unreachable_from_cloud for LAN-only paths', () => {
    // /mcp is lan-only in the default PUBLIC_RESOLUTION (mcp.public=false).
    const cloud_probe: CloudProbeResponse = {
      hostname: 'alice.recued.cloud',
      resolved_ip: '203.0.113.5',
      per_target: [
        { port: 443, kind: 'tls', role: 'mcp', reachable: false, tls_valid: false, cert_fingerprint: null, cert_expires_at: null, handshake_ms: 0 },
      ],
      recommendations: [],
      probed_at: 1_700_000_000_000,
    };
    const report = buildReachabilityReport(buildInputs({ cloud_probe }));
    expect(report.recommendations.some((r) => r.code === 'path_unreachable_from_cloud')).toBe(false);
  });

  it('emits cert_fingerprint_mismatch when cloud probe sees a different cert', () => {
    const cloud_probe: CloudProbeResponse = {
      hostname: 'alice.recued.cloud',
      resolved_ip: '203.0.113.5',
      per_target: [
        {
          port: 443,
          kind: 'tls',
          role: 'ws',
          reachable: true,
          tls_valid: true,
          cert_fingerprint: 'b'.repeat(64),
          cert_expires_at: 0,
          handshake_ms: 100,
        },
      ],
      recommendations: [],
      probed_at: 1_700_000_000_000,
    };
    const report = buildReachabilityReport(buildInputs({ cloud_probe }));
    expect(report.recommendations.some((r) => r.code === 'cert_fingerprint_mismatch')).toBe(true);
  });

  it('aggregates multiple same-role targets with AND so a failed check is not hidden', () => {
    // Two checks for the same public role: the failing tcp check comes FIRST
    // and a passing http check SECOND, so a naive last-wins map would have
    // reported the role reachable. AND-aggregation must still flag it.
    const cloud_probe: CloudProbeResponse = {
      hostname: 'alice.recued.cloud',
      resolved_ip: '203.0.113.5',
      per_target: [
        { port: 8443, kind: 'tcp', role: 'ws', reachable: false, handshake_ms: 0, last_error: 'refused' },
        { port: 443, kind: 'http', role: 'ws', reachable: true, tls_valid: true, cert_fingerprint: null, cert_expires_at: null, handshake_ms: 50 },
      ],
      recommendations: [],
      probed_at: 1_700_000_000_000,
    };
    const report = buildReachabilityReport(buildInputs({ cloud_probe }));
    const ws_entry = report.per_path.find((p) => p.role === 'ws');
    expect(ws_entry?.cloud_probe_reachable).toBe(false);
    expect(report.recommendations.some((r) => r.code === 'path_unreachable_from_cloud')).toBe(true);
  });
});

describe('sortRecommendations', () => {
  it('orders error before warning before info', () => {
    const sorted = sortRecommendations([
      { severity: 'info', code: 'nat_traversal_required', message: '' },
      { severity: 'error', code: 'tls_renewal_overdue', message: '' },
      { severity: 'warning', code: 'tls_renewal_imminent', message: '' },
    ]);
    expect(sorted.map((r) => r.severity)).toEqual(['error', 'warning', 'info']);
  });
});
