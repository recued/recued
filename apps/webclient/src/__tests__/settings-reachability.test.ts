/**
 * D-148 P6 — the reachability PROBE PLUMBING. The render-model this file was
 * named for is gone: the standalone Reachability panel folded into Settings →
 * Server → Connect a device, and `buildReachabilityReport` was deleted with it.
 * What survives here is the half a panel never owned — request construction,
 * the diagnostics caller, port answerability, and the from-here address check.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTIC_ALLOWED_PORTS,
  HOSTNAME_LISTENER_PORTS,
  type DiagnosticResponse,
} from '@recued/contracts';
import {
  buildReachabilityDiagnosticRequest,
  createReachabilityDiagnosticProbeCaller,
  diagnosticPortReachability,
  diagnosticResponseHasReachablePort,
  createAddressReachableFromHereCheck,
  isProbeAnswerablePort,
} from '../settings/reachability.js';

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

  it('D-272 — narrows to the ports and checks a caller NAMES', () => {
    // The measured cost this exists to cut: `runDiagnosticChecks` walks ports
    // sequentially with an `await` inside, under a 5s timeout each. Four ports
    // plus a TLS handshake is up to ~25s, and the reader who waits all of it is
    // the one whose router DROPs — the exact person the check is for.
    const req = buildReachabilityDiagnosticRequest({
      account_id: 'acct-1',
      hostname: 'alice.recued.cloud',
      ports: [8446],
      checks: ['port_reachability'],
    });
    expect(req.ports).toEqual([8446]);
    expect(req.checks).toEqual(['port_reachability']);
  });

  it('D-272 — a named check list does not suppress the ACME check', () => {
    // ⚠ The two are independent by construction: `acme_challenge` follows the
    // TOKEN. A caller that narrows its checks and also carries a token is the
    // shape that would break if the token clause read the list instead.
    const req = buildReachabilityDiagnosticRequest({
      account_id: 'acct-1',
      hostname: 'alice.recued.cloud',
      checks: ['port_reachability'],
      acme_challenge_token: 'token-1',
    });
    expect(req.checks).toEqual(['port_reachability', 'acme_challenge']);
  });

  it('D-272 — and does not send the ACME check twice when it is named', () => {
    const req = buildReachabilityDiagnosticRequest({
      account_id: 'acct-1',
      hostname: 'alice.recued.cloud',
      checks: ['acme_challenge'],
      acme_challenge_token: 'token-1',
    });
    expect(req.checks).toEqual(['acme_challenge']);
  });

  it('⛔ D-272 — `isProbeAnswerablePort` follows the WORKER allowlist, not the listener set', () => {
    // ⛔ A NARROWED REQUEST NAMING A DISALLOWED PORT IS REJECTED WHOLE. The
    // worker's `normalizePorts` THROWS `diagnostic_port_not_allowed` on the
    // first bad port rather than dropping it — so a caller must ask this before
    // it narrows, or it converts an honest "nobody asked" into a 400.
    for (const port of DIAGNOSTIC_ALLOWED_PORTS) {
      expect(isProbeAnswerablePort(port)).toBe(true);
    }
    // 8443 is D-148's PRE-AMENDMENT `ws` port and a plausible `public_port`.
    // ⚠ 7717 is NOT here either, and calling that "the loopback listener" (as
    // this comment did) is wrong: `resolveLanAddress` binds `0.0.0.0` in the
    // ordinary home case, so the LAN port is on every interface. Its absence
    // from the allowlist is therefore a GAP, not a definition — tracked on
    // D-272. Until it is closed, `null` (nobody asked) is still the only honest
    // reading, which is what this pins.
    expect(isProbeAnswerablePort(8443)).toBe(false);
    expect(isProbeAnswerablePort(7717)).toBe(false);
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

  it('⛔⛔ D-272 — the narrowing reaches the WIRE, not just the builder', async () => {
    // ⛔ A STUB PROVES THE CALL, NOT THE MESSAGE. `buildReachabilityDiagnosticRequest`
    // is tested above in isolation and the route's literal is tested in the route
    // suite — neither can see whether the override survives the caller in
    // between. This reads the bytes that would leave the browser.
    const bodies: unknown[] = [];
    const caller = createReachabilityDiagnosticProbeCaller({
      baseUrl: 'https://api.test.recued.cloud',
      fetcher: async (_input: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ data: buildDiagnosticResponse() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      resolveTarget: async () => ({
        account_id: 'acct-1',
        hostname: 'alice.recued.cloud',
      }),
    });

    await caller({ ports: [8446], checks: ['port_reachability'] });
    expect(bodies[0]).toMatchObject({ ports: [8446], checks: ['port_reachability'] });

    // ⚠ AND THE UNNARROWED CALLER IS UNCHANGED. The Reachability page asks about
    // every listener on purpose — an operator wants the whole picture — so this
    // widening must be additive, not a new default.
    await caller();
    expect(bodies[1]).toMatchObject({ ports: [...HOSTNAME_LISTENER_PORTS] });
    expect((bodies[1] as { checks: string[] }).checks).toContain('tls_handshake');
  });
});

describe('diagnosticPortReachability — the tri-state read', () => {
  /** ⛔ THE WHOLE REASON THIS EXISTS beside `diagnosticResponseHasReachablePort`.
   *  That one answers "may I show this address", where "checked and refused" and
   *  "nobody checked" both mean no. A checklist cannot collapse them: an unticked
   *  box tells the reader their router was looked at and found shut. */
  const portResult = (port: number, outcome: 'reachable' | 'blocked' | 'no_response') => ({
    kind: 'port_reachability' as const,
    status: outcome === 'reachable' ? ('pass' as const) : ('fail' as const),
    payload: { kind: 'port_reachability' as const, port, outcome },
  });

  it('reads a reachable port as true', () => {
    expect(diagnosticPortReachability(
      buildDiagnosticResponse({ results: [portResult(443, 'reachable')] }), 443,
    )).toBe(true);
  });

  it.each([['blocked'], ['no_response']] as const)(
    'reads %s as false — both mean "it did not get in"', (outcome) => {
      expect(diagnosticPortReachability(
        buildDiagnosticResponse({ results: [portResult(443, outcome)] }), 443,
      )).toBe(false);
    });

  it('⛔ reads a port the probe never carried as NULL, not false', () => {
    // The trap: a response full of passing checks for OTHER ports would read as
    // "443 is shut" under any `.some(...) === false` fold.
    expect(diagnosticPortReachability(
      buildDiagnosticResponse({ results: [portResult(8446, 'reachable')] }), 443,
    )).toBeNull();
    // ⚠ And 7717 NEVER has an answer here — it is not in the probe request and
    // not in the worker's allowlist, so "is my local port open to the public" is
    // a question nobody asked, not one answered no.
    expect(diagnosticPortReachability(buildDiagnosticResponse(), 7717)).toBeNull();
  });

  it('reads no response at all as null', () => {
    expect(diagnosticPortReachability(null, 443)).toBeNull();
    expect(diagnosticPortReachability(undefined, 443)).toBeNull();
    expect(diagnosticPortReachability(
      buildDiagnosticResponse({ results: [] }), 443,
    )).toBeNull();
  });

  it('⚠ one reachable result wins over a sibling that failed', () => {
    // The worker can carry more than one check per port. If any of them got in,
    // the router forwards the port — which is the question this step asks.
    expect(diagnosticPortReachability(buildDiagnosticResponse({
      results: [portResult(443, 'no_response'), portResult(443, 'reachable')],
    }), 443)).toBe(true);
  });

  it('agrees with the boolean read wherever the boolean read says yes', () => {
    const reachable = buildDiagnosticResponse({ results: [portResult(443, 'reachable')] });
    expect(diagnosticResponseHasReachablePort(reachable, 443)).toBe(true);
    expect(diagnosticPortReachability(reachable, 443)).toBe(true);
    // ...and diverges exactly where it should: no answer at all.
    const silent = buildDiagnosticResponse({ results: [] });
    expect(diagnosticResponseHasReachablePort(silent, 443)).toBe(false);
    expect(diagnosticPortReachability(silent, 443)).toBeNull();
  });
});

describe('D-272 — can this browser reach that address? (NAT hairpin)', () => {
  // ⚠ NOT `status: 0` — the `Response` constructor rejects it (200-599 only), so
  // that fixture THREW and the check dutifully returned false. A real opaque
  // response reports status 0 but cannot be constructed; this code never reads
  // the response, so any resolved value is a faithful stand-in.
  const mkResponse = () => new Response(null, { status: 200 });

  it('⛔ RESOLVE means reachable — measured: only a real connection resolves', () => {
    // Real Chromium, 2026-09-16: a cross-origin `no-cors` fetch resolves only
    // after DNS + TCP + a TRUSTED TLS handshake + an HTTP response. A
    // self-signed cert rejects. So resolve is a strong positive.
    const check = createAddressReachableFromHereCheck({
      fetcher: async () => mkResponse(),
    });
    return expect(check('https://home.example.com/webclient/')).resolves.toBe(true);
  });

  it('⛔ EVERY failure is `false`, and none of them names a cause', async () => {
    // Measured: TLS-untrusted, connection-refused and DNS-failure are ALL
    // `TypeError: Failed to fetch`, indistinguishable. Inventing a router
    // diagnosis from a network error on this side of the router is the mistake
    // this decision keeps naming.
    for (const err of [
      new TypeError('Failed to fetch'),
      new DOMException('aborted', 'AbortError'),
      new Error('something else entirely'),
    ]) {
      const check = createAddressReachableFromHereCheck({
        fetcher: async () => { throw err; },
      });
      await expect(check('https://home.example.com/webclient/')).resolves.toBe(false);
    }
  });

  it('⛔⛔ ABORTS rather than hanging — a router that DROPs sends nothing back', async () => {
    // The measurement's one non-settling case: a blackholed address never
    // answers, so without the abort the promise waits for the browser's own
    // connect timeout. Hairpin failure is exactly that shape.
    let sawSignal: AbortSignal | undefined;
    const check = createAddressReachableFromHereCheck({
      timeoutMs: 5,
      fetcher: (_u, init) => new Promise((_res, rej) => {
        sawSignal = init?.signal ?? undefined;
        init?.signal?.addEventListener('abort', () => {
          rej(new DOMException('aborted', 'AbortError'));
        });
      }),
    });
    await expect(check('https://home.example.com/webclient/')).resolves.toBe(false);
    expect(sawSignal?.aborted).toBe(true);
  });

  it('⚠ sends a bare unauthenticated GET — no CORS needed, no bearer possible', async () => {
    // `no-cors` so an ordinary server with no CORS header still answers;
    // `omit` so this can never carry a token; `no-store` so a cached hit cannot
    // report reachability that is minutes old, which would defeat "right now".
    let init: RequestInit | undefined;
    const check = createAddressReachableFromHereCheck({
      fetcher: async (_u, i) => { init = i; return mkResponse(); },
    });
    await check('https://home.example.com/webclient/');
    expect(init).toMatchObject({
      mode: 'no-cors', method: 'GET', credentials: 'omit', cache: 'no-store',
    });
  });
});
