/** D-121 Phase 5 — `recued-server pair` CLI tests.
 *
 *  Covers daemon-model output (no [Enter] prompt), TTL line, URL
 *  enumeration ordering, the `?code=` deeplink + `--no-url-prefill`
 *  toggle, and the recovery-key first-pair note. */

import { describe, it, expect } from 'vitest';
import { cmdPair } from '../commands/pair.js';
import {
  enumerateServerUrls,
  formatUrlList,
  resolvePublicIp,
  collectLanInterfaces,
  PUBLIC_IP_CACHE_TTL_MS,
} from '../cli/url-enumerate.js';
import { createPairingManager } from '../pairing.js';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ────────────────────────────────────────────────────────────────
// cmdPair output
// ────────────────────────────────────────────────────────────────

// Reusable no-op enumerate deps so tests don't hit the real public-IP
// probe and don't accidentally read the cache file at ~/.recued/state.json.
const mkEnumerateDeps = () => ({
  networkInterfaces: () => ({
    eth0: [{ address: '192.168.1.42', family: 'IPv4' as const, internal: false }],
  }),
  fetchPublicIp: async () => null,
  cachePath: join(mkdtempSync(join(tmpdir(), 'recued-')), 'state.json'),
});

describe('cmdPair', () => {
  it('emits daemon-model output with TTL + deeplink (default)', async () => {
    const pairing = createPairingManager({ realmToken: 'realm-1' });
    const lines: string[] = [];
    await cmdPair(
      {
        pairing,
        enumerate: { configuredHostname: 'my.example.com', port: 8080 },
        enumerateDeps: mkEnumerateDeps() as any,
      },
      {
        out: (line) => lines.push(line),
        webappBaseUrl: 'https://app.recued.test/pair',
      },
    );
    const joined = lines.join('\n');
    expect(joined).toMatch(/Pairing code: [2-9A-HJ-NP-Za-km-z]{8}\s+\(TTL\s+\d+\s+min\)/);
    expect(joined).toContain('Server reachable at:');
    expect(joined).toContain('https://my.example.com');
    expect(joined).toContain('configured');
    expect(joined).toMatch(/https:\/\/app\.recued\.test\/pair\?code=/);
  });

  it('omits the ?code= prefix on --no-url-prefill', async () => {
    const pairing = createPairingManager({ realmToken: 'realm-1' });
    const lines: string[] = [];
    await cmdPair(
      {
        pairing,
        enumerate: { configuredHostname: 'my.example.com', port: 8080 },
        enumerateDeps: mkEnumerateDeps() as any,
      },
      {
        out: (line) => lines.push(line),
        webappBaseUrl: 'https://app.recued.test/pair',
        noUrlPrefill: true,
      },
    );
    const joined = lines.join('\n');
    expect(joined).toContain('https://app.recued.test/pair');
    expect(joined).not.toMatch(/\?code=/);
  });

  it('mentions first-pair recovery-key seeding when no check is enrolled', async () => {
    const pairing = createPairingManager({ realmToken: 'realm-1' });
    const recoveryKeyCheck = (() => {
      let stored: string | null = null;
      return {
        read: () => stored, write: (b: string) => { stored = b; },
        exists: () => stored !== null, clear: () => { stored = null; },
      };
    })();

    const lines: string[] = [];
    await cmdPair(
      {
        pairing, recoveryKeyCheck,
        enumerate: { configuredHostname: 'h', port: 8080 },
        enumerateDeps: mkEnumerateDeps() as any,
      },
      { out: (line) => lines.push(line), webappBaseUrl: 'https://app.recued.test/pair' },
    );
    expect(lines.join('\n')).toContain('first pair');
  });

  it('refreshes the pairing code on every invocation', async () => {
    const pairing = createPairingManager({ realmToken: 'realm-1' });
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const lines: string[] = [];
      await cmdPair(
        {
          pairing,
          enumerate: { configuredHostname: 'h', port: 8080 },
          enumerateDeps: mkEnumerateDeps() as any,
        },
        { out: (line) => lines.push(line) },
      );
      const m = lines.join('\n').match(/Pairing code:\s+([2-9A-HJ-NP-Za-km-z]{8})/);
      expect(m).not.toBeNull();
      codes.push(m![1]);
    }
    expect(new Set(codes).size).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────
// URL enumeration
// ────────────────────────────────────────────────────────────────

describe('enumerateServerUrls', () => {
  it('orders configured → LAN → public IP', async () => {
    const urls = await enumerateServerUrls(
      { configuredHostname: 'my.example.com', port: 8080 },
      {
        networkInterfaces: () => ({
          eth0: [{ address: '192.168.1.42', family: 'IPv4', internal: false } as any],
        }),
        fetchPublicIp: async () => '203.0.113.42',
        cachePath: join(mkdtempSync(join(tmpdir(), 'recued-')), 'state.json'),
      },
    );
    expect(urls.map((r) => r.source)).toEqual(['configured', 'LAN', 'public IP']);
    expect(urls[0].url).toBe('https://my.example.com');
    expect(urls[1].url).toBe('http://192.168.1.42:8080');
    expect(urls[2].url).toBe('https://203.0.113.42:8080');
  });

  it('skips configured row when hostname is empty', async () => {
    const urls = await enumerateServerUrls(
      { port: 8080 },
      {
        networkInterfaces: () => ({}),
        fetchPublicIp: async () => null,
        cachePath: join(mkdtempSync(join(tmpdir(), 'recued-')), 'state.json'),
      },
    );
    expect(urls).toEqual([]);
  });

  it('uses http://configured when configuredTls is false', async () => {
    const urls = await enumerateServerUrls(
      { configuredHostname: 'lan.example', configuredTls: false, port: 8080 },
      {
        networkInterfaces: () => ({}),
        fetchPublicIp: async () => null,
        cachePath: join(mkdtempSync(join(tmpdir(), 'recued-')), 'state.json'),
      },
    );
    expect(urls[0].url).toBe('http://lan.example');
  });

  it('formats IPv6 with brackets', async () => {
    const urls = await enumerateServerUrls(
      { port: 8080 },
      {
        networkInterfaces: () => ({
          eth0: [{ address: '2001:db8::1', family: 'IPv6', internal: false } as any],
        }),
        fetchPublicIp: async () => null,
        cachePath: join(mkdtempSync(join(tmpdir(), 'recued-')), 'state.json'),
      },
    );
    expect(urls[0].url).toBe('http://[2001:db8::1]:8080');
  });

  it('skips internal + link-local interfaces', () => {
    const ips = collectLanInterfaces({
      networkInterfaces: () => ({
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as any],
        en0: [
          { address: '192.168.1.42', family: 'IPv4', internal: false } as any,
          { address: 'fe80::1', family: 'IPv6', internal: false } as any,
        ],
      }),
    });
    expect(ips).toEqual(['192.168.1.42']);
  });
});

describe('resolvePublicIp', () => {
  it('caches the result for PUBLIC_IP_CACHE_TTL_MS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-'));
    const cachePath = join(dir, 'state.json');
    let calls = 0;
    const probe = async (): Promise<string> => { calls++; return '203.0.113.42'; };

    // First call hits the probe + writes cache
    const a = await resolvePublicIp({ cachePath, fetchPublicIp: probe, now: () => 1_000 });
    expect(a).toBe('203.0.113.42');
    expect(calls).toBe(1);

    // Second call within TTL — cache hit, no probe
    const b = await resolvePublicIp({ cachePath, fetchPublicIp: probe, now: () => 1_000 + 1_000 });
    expect(b).toBe('203.0.113.42');
    expect(calls).toBe(1);

    // After TTL — probe again
    const c = await resolvePublicIp({
      cachePath, fetchPublicIp: probe,
      now: () => 1_000 + PUBLIC_IP_CACHE_TTL_MS + 1,
    });
    expect(c).toBe('203.0.113.42');
    expect(calls).toBe(2);
  });

  it('falls back to stale cache when the probe fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-'));
    const cachePath = join(dir, 'state.json');
    writeFileSync(
      cachePath,
      JSON.stringify({ public_ip: { ip: '198.51.100.1', fetched_at: 1 } }),
      'utf-8',
    );
    const result = await resolvePublicIp({
      cachePath,
      fetchPublicIp: async () => null,
      now: () => 1 + PUBLIC_IP_CACHE_TTL_MS + 1,
    });
    expect(result).toBe('198.51.100.1');
  });

  it('preserves siblings when writing the cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-'));
    const cachePath = join(dir, 'state.json');
    writeFileSync(cachePath, JSON.stringify({ other_key: 'untouched' }), 'utf-8');
    await resolvePublicIp({
      cachePath, fetchPublicIp: async () => '203.0.113.99',
      now: () => Date.now(),
    });
    const stored = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
    expect(stored.other_key).toBe('untouched');
    expect((stored.public_ip as { ip: string }).ip).toBe('203.0.113.99');
  });
});

describe('formatUrlList', () => {
  it('aligns the source column on the right', () => {
    const out = formatUrlList([
      { url: 'https://a.com', source: 'configured' },
      { url: 'http://192.168.1.42:8080', source: 'LAN' },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/https:\/\/a\.com\s+configured$/);
    expect(lines[1]).toMatch(/http:\/\/192\.168\.1\.42:8080\s+LAN$/);
    // Source columns vertically align — same indent across rows
    const sourceColAt = (line: string): number => line.lastIndexOf('  ');
    expect(sourceColAt(lines[1])).toBeGreaterThanOrEqual(sourceColAt(lines[0]));
  });

  it('returns a hint when no URLs detected', () => {
    expect(formatUrlList([])).toContain('no reachable URLs');
  });
});
