/** D-148 W3.4 — two-listener path-routed orchestrator tests.
 *
 *  Plaintext-mode tests against the LAN listener (always plain HTTP)
 *  and the public listener with a null cert holder (upstream-TLS mode
 *  per § A.6.5 falls back to plaintext). The TLS path lives in
 *  cert-chain.test.ts + the listener layer's SNICallback is a thin
 *  wrapper around https.createServer(...) that reads through the
 *  shared holder we already exercise — no need to re-exercise here.
 *
 *  Acceptance per W3.3 handover:
 *  - co-exists with createListenerSet (legacy stays in place)
 *  - bind/unbind on both listeners
 *  - LAN listener returns 404 for public-only paths and vice versa
 *  - existing listener-set tests continue to pass unchanged */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createNetServer } from 'node:net';
import {
  DEFAULT_PATH_RESOLUTION,
  EXPOSURE_PRESET_PATH_MAP,
  type PathResolution,
  type PathRole,
  type TLSDomainCertChain,
} from '@recued/contracts';
import { createCertChainHolder } from '../cert-chain.js';
import {
  createPathListenerSet,
  DEFAULT_LAN_BIND_ADDRESS,
  DEFAULT_PUBLIC_BIND_ADDRESS,
  selectSniCertChain,
  tlsDomainSourceForHostnameCertSource,
  type PathListenerSet,
} from '../path-listener-set.js';
import type { PortRequestHandler, PortUpgradeHandler } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const buildEchoHandler = (body: string): PortRequestHandler =>
  async (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(body);
  };

const buildAllHandlers = (): Record<PathRole, PortRequestHandler> => ({
  health: buildEchoHandler('health-handler'),
  ws: buildEchoHandler('ws-handler'),
  mcp: buildEchoHandler('mcp-handler'),
  llm_gateway: buildEchoHandler('llm-gateway-handler'),
  webhooks: buildEchoHandler('webhooks-handler'),
  reception: buildEchoHandler('reception-handler'),
  oauth: buildEchoHandler('oauth-handler'),
  ask: buildEchoHandler('ask-handler'),
  webclient: buildEchoHandler('webclient-handler'),
});

const fetchPort = async (port: number, path: string): Promise<{ status: number; body: string }> => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, body: await r.text() };
};

const allPublic = (): Record<PathRole, PathResolution> => ({
  health: { lan: false, public: true },
  ws: { lan: false, public: true },
  mcp: { lan: false, public: true },
  llm_gateway: { lan: false, public: true },
  webhooks: { lan: false, public: true },
  reception: { lan: false, public: true },
  oauth: { lan: false, public: true },
  ask: { lan: false, public: true },
  webclient: { lan: false, public: true },
});

const allLan = (): Record<PathRole, PathResolution> => ({
  health: { lan: true, public: false },
  ws: { lan: true, public: false },
  mcp: { lan: true, public: false },
  llm_gateway: { lan: true, public: false },
  webhooks: { lan: true, public: false },
  reception: { lan: true, public: false },
  oauth: { lan: true, public: false },
  ask: { lan: true, public: false },
  webclient: { lan: true, public: false },
});

const certEntry = (
  source: TLSDomainCertChain['source'],
  domain = 'app.example',
): TLSDomainCertChain => ({
  domain,
  cert_pem: `cert:${domain}`,
  private_key_pem: `key:${domain}`,
  fingerprint: `fp:${domain}`,
  expires_at: 1_700_000_000_000,
  source,
});

let activeSet: PathListenerSet | null = null;
afterEach(async () => {
  if (activeSet) {
    await activeSet.stop();
    activeSet = null;
  }
});

// ────────────────────────────────────────────────────────────────
// Default bind addresses — § A.7.5 (Codex W3.4 P1 fold)
// ────────────────────────────────────────────────────────────────

describe('PathListenerSet — default bind addresses (§ A.7.5)', () => {
  it('LAN default is the loopback fallback, NOT the 0.0.0.0 wildcard', () => {
    // Spec § A.7.5: production LAN bind = detected primary LAN IP
    // (caller-resolved at W3.5). Substrate fallback is loopback so a
    // forgotten override cannot expose LAN-only paths to WAN / VPN /
    // tunnel interfaces. Codex W3.4 P1 fold pins this guarantee.
    expect(DEFAULT_LAN_BIND_ADDRESS).toBe('127.0.0.1');
    expect(DEFAULT_LAN_BIND_ADDRESS).not.toBe('0.0.0.0');
  });

  it('public default is the 0.0.0.0 wildcard per spec', () => {
    // Spec § A.7.5: public listener binds 0.0.0.0 so it accepts WAN
    // traffic post-port-forward / tunnel; per-path resolution filters
    // what's actually served.
    expect(DEFAULT_PUBLIC_BIND_ADDRESS).toBe('0.0.0.0');
  });
});

// ────────────────────────────────────────────────────────────────
// D-152 P0 SNI dispatch — hostname registry gate
// ────────────────────────────────────────────────────────────────

describe('PathListenerSet — D-152 hostname-gated SNI dispatch', () => {
  it('maps hostname cert sources onto tls_domain row sources', () => {
    expect(tlsDomainSourceForHostnameCertSource('recued_acme')).toBe('pro_acme');
    expect(tlsDomainSourceForHostnameCertSource('byo_uploaded')).toBe('byo_upload');
    expect(tlsDomainSourceForHostnameCertSource('byo_external')).toBeNull();
  });

  it('serves a cert only after hostname binding and cert-source agree', () => {
    const result = selectSniCertChain({
      servername: 'App.Example',
      hostname_binding_lookup: () => ({
        hostname: 'app.example',
        cert_source: 'byo_uploaded',
        tls_topology: 'server_terminated',
      }),
      tls_domain_lookup: (servername) => certEntry('byo_upload', servername),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.domain).toBe('app.example');
      expect(result.entry.source).toBe('byo_upload');
    }
  });

  it('rejects unknown or pending hostname bindings before cert lookup', () => {
    let certLookups = 0;
    const result = selectSniCertChain({
      servername: 'pending.example',
      hostname_binding_lookup: () => null,
      tls_domain_lookup: () => {
        certLookups += 1;
        return certEntry('byo_upload');
      },
    });

    expect(result).toEqual({ ok: false, reason: 'tls_hostname_unverified' });
    expect(certLookups).toBe(0);
  });

  it('rejects upstream-terminated hostnames during TLS handshakes', () => {
    const result = selectSniCertChain({
      servername: 'proxy.example',
      hostname_binding_lookup: () => ({
        hostname: 'proxy.example',
        cert_source: 'byo_external',
        tls_topology: 'upstream_terminated',
      }),
      tls_domain_lookup: () => certEntry('byo_upload'),
    });

    expect(result).toEqual({ ok: false, reason: 'tls_topology_not_server_terminated' });
  });

  it('rejects a hostname row whose cert source does not match tls_domains', () => {
    const result = selectSniCertChain({
      servername: 'alice.recued.cloud',
      hostname_binding_lookup: () => ({
        hostname: 'alice.recued.cloud',
        cert_source: 'recued_acme',
        tls_topology: 'server_terminated',
      }),
      tls_domain_lookup: () => certEntry('byo_upload', 'alice.recued.cloud'),
    });

    expect(result).toEqual({ ok: false, reason: 'tls_cert_source_mismatch' });
  });
});

// ────────────────────────────────────────────────────────────────
// Bind rule — § A.6.1
// ────────────────────────────────────────────────────────────────

describe('PathListenerSet — bind rule', () => {
  it('binds LAN only when any path resolves lan=true (default DEFAULT_PATH_RESOLUTION)', async () => {
    activeSet = createPathListenerSet({
      resolution: DEFAULT_PATH_RESOLUTION,
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
      public_port: 0,
      public_bind_address: '127.0.0.1',
    });
    const status = await activeSet.start();
    const lan = status.find((s) => s.listener === 'lan');
    const pub = status.find((s) => s.listener === 'public');
    // DEFAULT_PATH_RESOLUTION mirrors `lan_only` preset — LAN binds; public does not.
    expect(lan?.listening).toBe(true);
    expect(pub?.listening).toBe(false);
    expect(pub?.bind_address).toBe(null);
  });

  it('binds public when any path resolves public=true', async () => {
    activeSet = createPathListenerSet({
      resolution: allPublic(),
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
      public_port: 0,
      public_bind_address: '127.0.0.1',
    });
    const status = await activeSet.start();
    const lan = status.find((s) => s.listener === 'lan');
    const pub = status.find((s) => s.listener === 'public');
    expect(lan?.listening).toBe(false);
    expect(pub?.listening).toBe(true);
    // Plaintext (no cert) — public listener still binds; tls flag false.
    expect(pub?.tls).toBe(false);
  });

  it('binds both listeners when paths span both bits', async () => {
    const split: Record<PathRole, PathResolution> = {
      ...DEFAULT_PATH_RESOLUTION,
      ws: { lan: true, public: false },
      webhooks: { lan: false, public: true },
    };
    activeSet = createPathListenerSet({
      resolution: split,
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
      public_port: 0,
      public_bind_address: '127.0.0.1',
    });
    const status = await activeSet.start();
    expect(status.find((s) => s.listener === 'lan')?.listening).toBe(true);
    expect(status.find((s) => s.listener === 'public')?.listening).toBe(true);
  });

  it('binds neither listener on the maintenance preset (§ A.6.1: maintenance binds neither)', async () => {
    activeSet = createPathListenerSet({
      resolution: EXPOSURE_PRESET_PATH_MAP.maintenance,
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
      public_port: 0,
      public_bind_address: '127.0.0.1',
    });
    const status = await activeSet.start();
    expect(status.find((s) => s.listener === 'lan')?.listening).toBe(false);
    expect(status.find((s) => s.listener === 'public')?.listening).toBe(false);
    // Off-by-resolution → no failure recorded.
    expect(status.every((s) => s.failure === undefined)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Cross-listener isolation — § A.6.2
// ────────────────────────────────────────────────────────────────

describe('PathListenerSet — cross-listener isolation', () => {
  it('LAN listener serves only LAN-enabled paths; public-only path returns 404', async () => {
    const split: Record<PathRole, PathResolution> = {
      health: { lan: true, public: false },
      ws: { lan: true, public: false },
      mcp: { lan: false, public: true },
      llm_gateway: { lan: true, public: false },
      webhooks: { lan: false, public: true },
      reception: { lan: false, public: false },
      oauth: { lan: false, public: false },
      ask: { lan: false, public: false },
      webclient: { lan: true, public: false },
    };
    activeSet = createPathListenerSet({
      resolution: split,
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
      public_port: 0,
      public_bind_address: '127.0.0.1',
    });
    const status = await activeSet.start();
    const lan = status.find((s) => s.listener === 'lan')!;
    const pub = status.find((s) => s.listener === 'public')!;
    expect(lan.listening && pub.listening).toBe(true);

    // LAN-enabled path on LAN listener → handler response.
    const lanHealth = await fetchPort(lan.port, '/health');
    expect(lanHealth.status).toBe(200);
    expect(lanHealth.body).toBe('health-handler');

    // Public-only path on LAN listener → generic 404 (no fingerprint leak).
    const lanMcp = await fetchPort(lan.port, '/mcp');
    expect(lanMcp.status).toBe(404);
    expect(JSON.parse(lanMcp.body)).toEqual({ error: { code: 'not_found' } });

    // Public-enabled path on public listener → handler response.
    const pubMcp = await fetchPort(pub.port, '/mcp');
    expect(pubMcp.status).toBe(200);
    expect(pubMcp.body).toBe('mcp-handler');

    // LAN-only path on public listener → generic 404.
    const pubHealth = await fetchPort(pub.port, '/health');
    expect(pubHealth.status).toBe(404);
    expect(JSON.parse(pubHealth.body)).toEqual({ error: { code: 'not_found' } });

    // Path disabled on both bits → 404 from both listeners.
    const lanReception = await fetchPort(lan.port, '/reception');
    expect(lanReception.status).toBe(404);
    const pubReception = await fetchPort(pub.port, '/reception');
    expect(pubReception.status).toBe(404);
  });

  it('unknown paths return generic 404 on both listeners (no fingerprint)', async () => {
    activeSet = createPathListenerSet({
      resolution: allLan(),
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
    });
    const status = await activeSet.start();
    const lan = status.find((s) => s.listener === 'lan')!;
    const r = await fetchPort(lan.port, '/totally-unknown');
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: { code: 'not_found' } });
  });

  it('boundary discipline: /mcpevil does not match the mcp role (404 not handler)', async () => {
    activeSet = createPathListenerSet({
      resolution: allLan(),
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
    });
    const status = await activeSet.start();
    const lan = status.find((s) => s.listener === 'lan')!;
    const r = await fetchPort(lan.port, '/mcpevil');
    expect(r.status).toBe(404);
    // Critical: response is the generic 404, not the mcp handler's body.
    expect(r.body).not.toContain('mcp-handler');
  });

  it('sub-paths under a role route to the role handler (/mcp/catalog → mcp role)', async () => {
    activeSet = createPathListenerSet({
      resolution: allLan(),
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
    });
    const status = await activeSet.start();
    const lan = status.find((s) => s.listener === 'lan')!;
    const r = await fetchPort(lan.port, '/mcp/catalog');
    expect(r.status).toBe(200);
    expect(r.body).toBe('mcp-handler');
  });

  it('missing role handler returns 404 (not 500; no fingerprint leak)', async () => {
    const partial: Partial<Record<PathRole, PortRequestHandler>> = {
      health: buildEchoHandler('health-handler'),
      // ws / mcp / webhooks / reception intentionally omitted
    };
    activeSet = createPathListenerSet({
      resolution: allLan(),
      handlers: partial,
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
    });
    const status = await activeSet.start();
    const lan = status.find((s) => s.listener === 'lan')!;
    expect(lan.listening).toBe(true);
    const r = await fetchPort(lan.port, '/webhooks/foo/bar');
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: { code: 'not_found' } });
  });
});

// ────────────────────────────────────────────────────────────────
// Failure handling — § P6 risk row
// ────────────────────────────────────────────────────────────────

describe('PathListenerSet — failure handling', () => {
  it('records port_in_use when LAN port is squatted; public still binds', async () => {
    const squatter = createNetServer();
    const squatPort = await new Promise<number>((resolve) => {
      squatter.listen(0, '127.0.0.1', () => {
        const addr = squatter.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    try {
      activeSet = createPathListenerSet({
        resolution: {
          ...DEFAULT_PATH_RESOLUTION,
          mcp: { lan: false, public: true },
        },
        handlers: buildAllHandlers(),
        cert_chain: createCertChainHolder(null),
        lan_port: squatPort,
        lan_bind_address: '127.0.0.1',
        public_port: 0,
        public_bind_address: '127.0.0.1',
      });
      const status = await activeSet.start();
      const lan = status.find((s) => s.listener === 'lan')!;
      const pub = status.find((s) => s.listener === 'public')!;
      expect(lan.listening).toBe(false);
      expect(lan.failure).toBe('port_in_use');
      // Public sibling still booted — graceful degradation per § P6.
      expect(pub.listening).toBe(true);
    } finally {
      squatter.close();
    }
  });

  it('status() surfaces failure rows + recovered rows', async () => {
    activeSet = createPathListenerSet({
      resolution: allLan(),
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
    });
    await activeSet.start();
    const post = activeSet.status();
    expect(post.find((s) => s.listener === 'lan')?.listening).toBe(true);
    // Public listener was off-by-resolution → listening:false, no failure.
    const pubRow = post.find((s) => s.listener === 'public');
    expect(pubRow?.listening).toBe(false);
    expect(pubRow?.failure).toBeUndefined();
    expect(pubRow?.bind_address).toBe(null);
  });
});

// ────────────────────────────────────────────────────────────────
// Lifecycle — start / stop
// ────────────────────────────────────────────────────────────────

describe('PathListenerSet — lifecycle', () => {
  it('stop() closes active listeners; status reflects no-listening', async () => {
    activeSet = createPathListenerSet({
      resolution: allLan(),
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
    });
    await activeSet.start();
    await activeSet.stop();
    const post = activeSet.status();
    expect(post.every((s) => !s.listening)).toBe(true);
    activeSet = null;
  });

  it('start() can be called against a maintenance config without error', async () => {
    activeSet = createPathListenerSet({
      resolution: EXPOSURE_PRESET_PATH_MAP.maintenance,
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
      public_port: 0,
      public_bind_address: '127.0.0.1',
    });
    const status = await activeSet.start();
    expect(status).toHaveLength(2);
    expect(status.every((s) => !s.listening)).toBe(true);
  });

  it('handler that rejects yields a controlled 500 (no unhandled rejection)', async () => {
    let observed: string | null = null;
    const failingHandler: PortRequestHandler = async () => {
      throw new Error('boom');
    };
    activeSet = createPathListenerSet({
      resolution: allLan(),
      handlers: {
        health: failingHandler,
        ws: buildEchoHandler('ws'),
        mcp: buildEchoHandler('mcp'),
        webhooks: buildEchoHandler('webhooks'),
        reception: buildEchoHandler('reception'),
      },
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
      log: (level, msg, data) => {
        if (level === 'error' && msg.includes('handler failed')) {
          observed = (data?.error as string) || '';
        }
      },
    });
    const status = await activeSet.start();
    const lan = status.find((s) => s.listener === 'lan')!;
    const r = await fetchPort(lan.port, '/health');
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: { code: 'internal_error' } });
    expect(observed).toBe('boom');
  });
});

// ────────────────────────────────────────────────────────────────
// Upgrade wiring — Codex W3.3 P1 #1 carry-forward
// ────────────────────────────────────────────────────────────────

describe('PathListenerSet — upgrade wiring', () => {
  it('routes WS upgrade to the role upgrade handler when /ws is enabled', async () => {
    let upgradeFired = false;
    let observedPath: string | null = null;
    const wsUpgrade: PortUpgradeHandler = (req, socket) => {
      upgradeFired = true;
      observedPath = req.url ?? '';
      // Mimic the real handler shape — write a minimal switching-protocols
      // response then drop the socket (this test only verifies the wire-up,
      // not the WS protocol).
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.destroy();
    };
    activeSet = createPathListenerSet({
      resolution: allLan(),
      handlers: buildAllHandlers(),
      upgradeHandlers: { ws: wsUpgrade },
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
    });
    const status = await activeSet.start();
    const lan = status.find((s) => s.listener === 'lan')!;
    // Manual upgrade attempt via raw socket — fetch() doesn't expose upgrades.
    await new Promise<void>((resolve, reject) => {
      const { Socket } = require('node:net') as typeof import('node:net');
      const client = new Socket();
      client.connect(lan.port, '127.0.0.1', () => {
        client.write(
          [
            'GET /ws HTTP/1.1',
            `Host: 127.0.0.1:${lan.port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        );
      });
      client.on('data', () => {
        // Server wrote switching-protocols + destroyed; we don't parse.
        client.destroy();
      });
      client.on('close', () => resolve());
      client.on('error', reject);
      setTimeout(() => reject(new Error('upgrade test timeout')), 2000).unref();
    });
    expect(upgradeFired).toBe(true);
    expect(observedPath).toBe('/ws');
  });

  it('rejects upgrade on path disabled per listener (raw 404 line)', async () => {
    const wsUpgrade: PortUpgradeHandler = (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n');
      socket.destroy();
    };
    activeSet = createPathListenerSet({
      // /ws disabled on LAN; only /health on LAN
      resolution: {
        health: { lan: true, public: false },
        ws: { lan: false, public: true },
        mcp: { lan: false, public: false },
        llm_gateway: { lan: false, public: false },
        webhooks: { lan: false, public: false },
        reception: { lan: false, public: false },
        oauth: { lan: false, public: false },
        ask: { lan: false, public: false },
        webclient: { lan: true, public: false },
      },
      handlers: buildAllHandlers(),
      upgradeHandlers: { ws: wsUpgrade },
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
      public_port: 0,
      public_bind_address: '127.0.0.1',
    });
    const status = await activeSet.start();
    const lan = status.find((s) => s.listener === 'lan')!;
    const response = await new Promise<string>((resolve, reject) => {
      const { Socket } = require('node:net') as typeof import('node:net');
      const client = new Socket();
      let buf = '';
      client.connect(lan.port, '127.0.0.1', () => {
        client.write(
          [
            'GET /ws HTTP/1.1',
            `Host: 127.0.0.1:${lan.port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        );
      });
      client.on('data', (chunk) => {
        buf += chunk.toString('utf8');
      });
      client.on('close', () => resolve(buf));
      client.on('error', reject);
      setTimeout(() => reject(new Error('upgrade reject test timeout')), 2000).unref();
    });
    // LAN dispatcher's /ws bit is false → upgrade rejected with the raw 404.
    expect(response).toContain('HTTP/1.1 404 Not Found');
    expect(response).toContain('Connection: close');
  });
});

// ────────────────────────────────────────────────────────────────
// applyResolution — exposure-flip robustness (D-148 § A.7.4)
//
// Reconfiguring exposure must NOT tear down a listener that stays up.
// The old coordinator path closed + rebuilt the whole set on every
// transition; `server.close()` on a LAN listener carrying a live
// control WS blocks forever (the upgraded socket never drains on its
// own), wedging the rebind so the LAN socket dies and never returns.
// `applyResolution` updates routing through the live dispatcher and
// only binds/unbinds a listener whose bind decision actually flipped.
// ────────────────────────────────────────────────────────────────

/** Raw one-shot GET with `Connection: close` so the server closes the
 *  socket after responding — no undici keep-alive pooling to wedge a
 *  later graceful `stop()`. Returns the numeric status. */
const rawGetStatus = (port: number, path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const { Socket } = require('node:net') as typeof import('node:net');
    const client = new Socket();
    let buf = '';
    client.connect(port, '127.0.0.1', () => {
      client.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    client.on('data', (chunk) => { buf += chunk.toString('utf8'); });
    client.on('close', () => {
      const m = buf.match(/^HTTP\/1\.1 (\d+)/);
      resolve(m ? Number(m[1]) : 0);
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('rawGetStatus timeout')), 2000).unref();
  });

/** A WS upgrade handler that completes the 101 handshake and HOLDS the
 *  socket open (never closes it) — the live-control-WS the wedge needs.
 *  Server-side sockets are collected so the test can drop them in
 *  teardown (a held upgraded socket would otherwise keep `stop()`'s
 *  `server.close()` pending). */
const buildHoldingUpgrade = (): {
  handler: PortUpgradeHandler;
  serverSockets: Array<import('node:net').Socket>;
} => {
  const serverSockets: Array<import('node:net').Socket> = [];
  const handler: PortUpgradeHandler = (_req, socket) => {
    serverSockets.push(socket);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    // Deliberately hold — do NOT destroy the socket.
  };
  return { handler, serverSockets };
};

/** Open a client socket, perform the WS handshake against `/ws`, and
 *  resolve once the 101 is seen — keeping the socket open. */
const openHeldWs = (port: number): Promise<import('node:net').Socket> =>
  new Promise((resolve, reject) => {
    const { Socket } = require('node:net') as typeof import('node:net');
    const client = new Socket();
    client.connect(port, '127.0.0.1', () => {
      client.write(
        [
          'GET /ws HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      );
    });
    client.on('data', (chunk) => {
      if (chunk.toString('utf8').includes('101')) resolve(client);
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('openHeldWs timeout')), 2000).unref();
  });

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | 'TIMED_OUT'> =>
  Promise.race([p, new Promise<'TIMED_OUT'>((r) => setTimeout(() => r('TIMED_OUT'), ms).unref())]);

describe('PathListenerSet — applyResolution (exposure-flip robustness)', () => {
  it('flips a path ON in place WITHOUT rebuilding the LAN listener (port stable)', async () => {
    const start = allLan();
    start.reception = { lan: false, public: false };
    activeSet = createPathListenerSet({
      resolution: start,
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
    });
    const initial = await activeSet.start();
    const port = initial.find((s) => s.listener === 'lan')!.port;
    expect(await rawGetStatus(port, '/reception/_health')).toBe(404); // off

    const next = allLan();
    next.reception = { lan: true, public: false };
    const after = await activeSet.applyResolution(next);
    const lan = after.find((s) => s.listener === 'lan')!;
    // Same OS-picked port ⇒ the listening socket was NOT rebuilt.
    expect(lan.port).toBe(port);
    expect(lan.listening).toBe(true);
    // The live dispatcher now serves the newly-enabled path.
    expect(await rawGetStatus(port, '/reception/_health')).toBe(200);
  });

  it('does NOT wedge while a live WS is held; the WS survives the flip', async () => {
    const { handler, serverSockets } = buildHoldingUpgrade();
    const start = allLan();
    start.reception = { lan: false, public: false };
    activeSet = createPathListenerSet({
      resolution: start,
      handlers: buildAllHandlers(),
      upgradeHandlers: { ws: handler },
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
    });
    const initial = await activeSet.start();
    const port = initial.find((s) => s.listener === 'lan')!.port;

    // Hold a live control WS on the LAN listener — the wedge precondition.
    const heldClient = await openHeldWs(port);
    expect(heldClient.destroyed).toBe(false);

    const next = allLan();
    next.reception = { lan: true, public: false };
    // The OLD destroy-then-rebuild path would block here forever on
    // server.close() draining the held WS. applyResolution must resolve.
    const outcome = await withTimeout(activeSet.applyResolution(next), 4000);
    expect(outcome).not.toBe('TIMED_OUT');

    const lan = (outcome as Awaited<ReturnType<PathListenerSet['applyResolution']>>)
      .find((s) => s.listener === 'lan')!;
    expect(lan.port).toBe(port); // untouched
    expect(lan.listening).toBe(true);
    expect(heldClient.destroyed).toBe(false); // WS NOT dropped — seamless toggle
    expect(await rawGetStatus(port, '/reception/_health')).toBe(200);

    // Teardown: drop the held sockets so the graceful stop() completes.
    heldClient.destroy();
    for (const s of serverSockets) s.destroy();
  });

  it('binds a listener that was off (off→on)', async () => {
    // Start with NO LAN path enabled → LAN listener not bound.
    const start: Record<PathRole, PathResolution> = {
      health: { lan: false, public: false },
      ws: { lan: false, public: false },
      mcp: { lan: false, public: false },
      llm_gateway: { lan: false, public: false },
      webhooks: { lan: false, public: false },
      reception: { lan: false, public: false },
      oauth: { lan: false, public: false },
      ask: { lan: false, public: false },
      webclient: { lan: false, public: false },
    };
    activeSet = createPathListenerSet({
      resolution: start,
      handlers: buildAllHandlers(),
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
    });
    const initial = await activeSet.start();
    expect(initial.find((s) => s.listener === 'lan')!.listening).toBe(false);

    const next = { ...start, health: { lan: true, public: false } };
    const after = await activeSet.applyResolution(next);
    const lan = after.find((s) => s.listener === 'lan')!;
    expect(lan.listening).toBe(true);
    expect(await rawGetStatus(lan.port, '/health')).toBe(200);
  });

  it('rebuilds a still-up listener when its TLS mode flips (plaintext→https)', async () => {
    // Start the public listener plaintext (empty cert holder).
    const holder = createCertChainHolder(null);
    activeSet = createPathListenerSet({
      resolution: allPublic(),
      handlers: buildAllHandlers(),
      cert_chain: holder,
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
      public_port: 0,
      public_bind_address: '127.0.0.1',
    });
    const initial = await activeSet.start();
    const pub0 = initial.find((s) => s.listener === 'public')!;
    expect(pub0.listening).toBe(true);
    expect(pub0.tls).toBe(false); // plaintext (no cert)

    // A cert lands in the holder — the public listener must now go https.
    // (cert is intentionally invalid: the rebuild ATTEMPT is what we're
    // asserting; a real cert would bind tls=true. An invalid one surfaces
    // tls_load_failed, which equally proves the rebuild fired instead of
    // leaving the listener plaintext.)
    holder.rotate({ cert_pem: 'not-a-real-cert', private_key_pem: 'not-a-real-key' });
    const after = await activeSet.applyResolution(allPublic());
    const pub1 = after.find((s) => s.listener === 'public')!;
    // Guard fired: the plaintext listener was torn down + rebuilt as https
    // (which fails to load the bogus cert). It is NOT still plaintext-up.
    expect(pub1.listening).toBe(false);
    expect(pub1.failure).toBe('tls_load_failed');
  });

  it('force-unbinds a listener going off even with a held WS (no hang)', async () => {
    const { handler, serverSockets } = buildHoldingUpgrade();
    activeSet = createPathListenerSet({
      resolution: allLan(),
      handlers: buildAllHandlers(),
      upgradeHandlers: { ws: handler },
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
      lan_bind_address: '127.0.0.1',
    });
    const initial = await activeSet.start();
    const port = initial.find((s) => s.listener === 'lan')!.port;
    const heldClient = await openHeldWs(port);

    // Turn EVERY LAN path off → the LAN listener must go down. The held
    // WS must not block the unbind (force-close drops it).
    const allOff: Record<PathRole, PathResolution> = {
      health: { lan: false, public: false },
      ws: { lan: false, public: false },
      mcp: { lan: false, public: false },
      llm_gateway: { lan: false, public: false },
      webhooks: { lan: false, public: false },
      reception: { lan: false, public: false },
      oauth: { lan: false, public: false },
      ask: { lan: false, public: false },
      webclient: { lan: false, public: false },
    };
    const outcome = await withTimeout(activeSet.applyResolution(allOff), 4000);
    expect(outcome).not.toBe('TIMED_OUT');
    const lan = (outcome as Awaited<ReturnType<PathListenerSet['applyResolution']>>)
      .find((s) => s.listener === 'lan')!;
    expect(lan.listening).toBe(false);

    heldClient.destroy();
    for (const s of serverSockets) s.destroy();
  });
});
