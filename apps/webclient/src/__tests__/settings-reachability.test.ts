/** D-148 P6 — Settings → Reachability render-model. */

import { describe, expect, it, vi } from 'vitest';
import {
  HOSTNAME_LISTENER_PORTS,
  type DiagnosticResponse,
  type ReachabilityReport,
} from '@recued/contracts';
import {
  buildReachabilityDiagnosticRequest,
  buildReachabilityRenderModel,
  createReachabilityDiagnosticProbeCaller,
  mountReachabilityPanel,
  REMEDIATION_COPY,
} from '../settings/reachability.js';

const buildReport = (overrides: Partial<ReachabilityReport> = {}): ReachabilityReport => ({
  report_id: 'r-1',
  generated_at: 1_700_000_000_000,
  server_passport_fingerprint: 'fp',
  network: {
    public_ipv4: '203.0.113.5',
    detected_via: 'cloud_probe',
    behind_nat: false,
    upnp_status: 'enabled',
  },
  dns: {
    handle: 'alice',
    ddns_resolves: true,
    resolved_to_expected_ip: true,
    resolution_ms: 50,
    last_ddns_update: 1_700_000_000_000,
  },
  tls: {
    cert_fingerprint: 'a'.repeat(64),
    expires_at: 1_800_000_000_000,
    days_until_expiry: 60,
    issuer: "Let's Encrypt",
    san: ['alice.recued.cloud'],
    valid_for_handle: true,
    renewal_overdue: false,
  },
  per_path: [
    { role: 'ws', lan_listening: true, public_listening: true, handshake_test: { passed: true, ms: 0 } },
  ],
  webhooks: [],
  bridges: [],
  webclients: [],
  recommendations: [],
  ...overrides,
});

const buildDiagnosticResponse = (
  overrides: Partial<DiagnosticResponse> = {},
): DiagnosticResponse => ({
  account_id: 'acct-1',
  hostname: 'alice.recued.cloud',
  detected_public_ip: '203.0.113.5',
  resolved_ips: ['203.0.113.5'],
  probed_at: 1_700_000_000_000,
  results: [
    {
      kind: 'detected_public_ip',
      status: 'pass',
      payload: { kind: 'detected_public_ip', ip: '203.0.113.5', ip_version: 4 },
    },
    {
      kind: 'port_reachability',
      status: 'fail',
      payload: {
        kind: 'port_reachability',
        port: 443,
        outcome: 'blocked',
      },
      remediation_hint: 'Check listener binding, firewall, and port-forwarding for port 443.',
    },
  ],
  ...overrides,
});

const makeHost = (): HTMLElement => {
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Array<(ev: Event) => void>>();
  return {
    innerHTML: '',
    setAttribute(k: string, v: string) {
      attrs.set(k, v);
    },
    removeAttribute(k: string) {
      attrs.delete(k);
    },
    getAttribute(k: string) {
      return attrs.get(k) ?? null;
    },
    addEventListener(name: string, fn: (ev: Event) => void) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
    },
    removeEventListener(name: string, fn: (ev: Event) => void) {
      const list = listeners.get(name) ?? [];
      listeners.set(name, list.filter((entry) => entry !== fn));
    },
  } as unknown as HTMLElement;
};

describe('buildReachabilityRenderModel', () => {
  it('renders healthy badge when no recommendations', () => {
    const model = buildReachabilityRenderModel(buildReport());
    expect(model.severity_summary.badge).toBe('healthy');
    expect(model.severity_summary.error_count).toBe(0);
  });

  it('renders attention badge on warning-only recommendations', () => {
    const model = buildReachabilityRenderModel(buildReport({
      recommendations: [
        { severity: 'warning', code: 'tls_renewal_imminent', message: 'soon' },
      ],
    }));
    expect(model.severity_summary.badge).toBe('attention');
    expect(model.severity_summary.warning_count).toBe(1);
  });

  it('renders critical badge when any error is present', () => {
    const model = buildReachabilityRenderModel(buildReport({
      recommendations: [
        { severity: 'error', code: 'tls_renewal_overdue', message: 'expired soon' },
        { severity: 'warning', code: 'tls_renewal_imminent', message: 'soon' },
      ],
    }));
    expect(model.severity_summary.badge).toBe('critical');
  });

  it('sorts recommendations error → warning → info', () => {
    const model = buildReachabilityRenderModel(buildReport({
      recommendations: [
        { severity: 'info', code: 'nat_traversal_required', message: '' },
        { severity: 'error', code: 'tls_renewal_overdue', message: '' },
        { severity: 'warning', code: 'tls_renewal_imminent', message: '' },
      ],
    }));
    expect(model.recommendations.map((r) => r.severity)).toEqual(['error', 'warning', 'info']);
  });

  it('falls back to canonical remediation copy when report omits it', () => {
    const model = buildReachabilityRenderModel(buildReport({
      recommendations: [
        { severity: 'error', code: 'tls_renewal_overdue', message: '' },
      ],
    }));
    expect(model.recommendations[0].remediation).toBe(REMEDIATION_COPY.tls_renewal_overdue);
  });

  it('uses report-supplied remediation when present', () => {
    const model = buildReachabilityRenderModel(buildReport({
      recommendations: [
        { severity: 'error', code: 'tls_renewal_overdue', message: 'msg', remediation: 'do this specific thing' },
      ],
    }));
    expect(model.recommendations[0].remediation).toBe('do this specific thing');
  });

  it('shortens the cert fingerprint for display', () => {
    const model = buildReachabilityRenderModel(buildReport());
    expect(model.tls_summary.fingerprint_short).toMatch(/^[a-f0-9]+…[a-f0-9]+$/);
  });

  it('exposes the cloud-probe enable hint', () => {
    expect(buildReachabilityRenderModel(buildReport()).can_run_cloud_probe).toBe(true);
    expect(buildReachabilityRenderModel(buildReport(), { can_run_cloud_probe: false }).can_run_cloud_probe).toBe(false);
  });

  // Codex FU2 P2 #2 fold — per_domain_tls must round-trip through the
  // render model so the Settings page can render multi-domain TLS
  // health alongside the single primary cert.
  it('per_domain_tls defaults to empty array when the report omits the field', () => {
    const model = buildReachabilityRenderModel(buildReport());
    expect(model.per_domain_tls).toEqual([]);
  });

  it('forwards per_domain_tls entries from the report to the render model', () => {
    const model = buildReachabilityRenderModel(buildReport({
      per_domain_tls: [
        {
          domain: 'alpha.example',
          fingerprint: 'a'.repeat(64),
          expires_at: 1_800_000_000_000,
          days_until_expiry: 30,
          issuer: "Let's Encrypt",
          source: 'pro_acme',
          chain_valid: true,
          fingerprint_matches: true,
        },
        {
          domain: 'beta.example',
          fingerprint: 'b'.repeat(64),
          expires_at: 1_800_000_000_000,
          days_until_expiry: 5,
          issuer: 'Internal CA',
          source: 'byo_upload',
          chain_valid: false,
          fingerprint_matches: true,
        },
      ],
    }));
    expect(model.per_domain_tls).toHaveLength(2);
    expect(model.per_domain_tls[0].domain).toBe('alpha.example');
    expect(model.per_domain_tls[1].chain_valid).toBe(false);
  });

  it('REMEDIATION_COPY carries tls_chain_invalid_for_domain copy', () => {
    expect(REMEDIATION_COPY.tls_chain_invalid_for_domain).toMatch(/intermediate chain/);
  });
});

describe('Reachability external diagnostics', () => {
  it('builds the diagnostics worker request from the target context', () => {
    const req = buildReachabilityDiagnosticRequest({
      account_id: 'acct-1',
      hostname: 'alice.recued.cloud',
      expected_public_ip: '203.0.113.5',
    });
    expect(req).toMatchObject({
      account_id: 'acct-1',
      hostname: 'alice.recued.cloud',
      expected_public_ip: '203.0.113.5',
      ports: [...HOSTNAME_LISTENER_PORTS],
    });
    expect(req.checks).toEqual([
      'detected_public_ip',
      'port_reachability',
      'dns_resolution',
      'tls_handshake',
      'nat_class',
    ]);
  });

  it('adds ACME diagnostics only when a challenge token is supplied', () => {
    const req = buildReachabilityDiagnosticRequest({
      account_id: 'acct-1',
      hostname: 'alice.recued.cloud',
      acme_challenge_token: 'token-1',
    });
    expect(req.checks).toContain('acme_challenge');
    expect(req.acme_challenge_token).toBe('token-1');
  });

  it('includes ownership proof observation only when requested', () => {
    const req = buildReachabilityDiagnosticRequest({
      account_id: 'acct-1',
      hostname: 'pages.example',
      ownership_probe_method: 'dns_txt',
    });

    expect(req.ownership_probe_method).toBe('dns_txt');
  });

  it('posts to /v1/diagnostics/probe and unwraps the worker response envelope', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: buildDiagnosticResponse() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const caller = createReachabilityDiagnosticProbeCaller({
      baseUrl: 'https://api.test.recued.cloud/some-prefix',
      fetcher,
      resolveTarget: async () => ({
        account_id: 'acct-1',
        hostname: 'alice.recued.cloud',
      }),
    });

    const res = await caller({ hostname: 'pages.example', ownership_probe_method: 'dns_txt' });

    expect(res.hostname).toBe('alice.recued.cloud');
    expect(calls[0]?.input).toBe('https://api.test.recued.cloud/v1/diagnostics/probe');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      account_id: 'acct-1',
      hostname: 'pages.example',
      ownership_probe_method: 'dns_txt',
    });
  });

  it('renders external probe results after the button caller resolves', async () => {
    const host = makeHost();
    const runExternalProbe = vi.fn(async () => buildDiagnosticResponse());
    const mount = mountReachabilityPanel({
      host,
      report: buildReport(),
      runExternalProbe,
    });

    expect(host.innerHTML).toContain('Run external probe');
    await mount.runExternalProbe();

    expect(runExternalProbe).toHaveBeenCalledTimes(1);
    expect(mount.getState().status).toBe('success');
    expect(host.innerHTML).toContain('External probe for alice.recued.cloud');
    expect(host.innerHTML).toContain('Port 443: blocked');
    expect(host.innerHTML).toContain('Check listener binding');

    mount.dispose();
    expect(host.innerHTML).toBe('');
  });
});
