/** D-152 P0 — hostname registry contract helpers. */

import { describe, expect, it } from 'vitest';
import type { HostnameAddRequest } from '../index.js';
import { MCP_RESERVED_RPC_PREFIXES } from '../mcp-tool-catalog.js';
import { SERVER_RPC_METHOD_SET } from '../rpc/server-registry.js';
import {
  canBindHostname,
  isSingleLabelProDdnsHostname,
  normalizeHostname,
  projectHostname,
  tlsTopologyForHostnameCertSource,
  type HostnameStorageRow,
} from '../hostname.js';

const row = (overrides: Partial<HostnameStorageRow> = {}): HostnameStorageRow => ({
  hostname_id: 'host-1',
  server_identity_id: 'server-1',
  hostname_normalized: 'alice.example',
  cert_source: 'byo_uploaded',
  cert_blob_id: 'blob-1',
  cert_fingerprint: 'abc123',
  cert_expires_at: 1_800_000_000_000,
  cert_chain_metadata: { issuer: 'CA', subject: 'alice.example' },
  ownership_status: 'verified',
  verification_method: 'cert_proof',
  verification_token_hash: 'token-hash',
  verified_at: 1_700_000_000_000,
  listener_ports: [443],
  ddns_managed: false,
  enabled: true,
  tls_topology: 'server_terminated',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  ...overrides,
});

describe('D-152 P0 hostname contracts', () => {
  it('normalizes bare hostnames and rejects schemes, paths, ports, and bad labels', () => {
    expect(normalizeHostname('  CASE.Example.  ')).toBe('case.example');
    expect(normalizeHostname('bücher.example')).toBe('xn--bcher-kva.example');

    for (const bad of [
      '',
      'https://example.com',
      'example.com/path',
      'example.com:443',
      '-bad.example',
      'bad-.example',
      'single-label',
    ]) {
      expect(normalizeHostname(bad), bad).toBeNull();
    }
  });

  it('pins Pro DDNS handles to exactly one label under an enabled zone', () => {
    expect(isSingleLabelProDdnsHostname('alice.recued.net')).toBe(true);
    expect(isSingleLabelProDdnsHostname('a-b.recued.net')).toBe(true);
    expect(isSingleLabelProDdnsHostname('a.b.recued.net')).toBe(false);
    expect(isSingleLabelProDdnsHostname('recued.net')).toBe(false);
    expect(isSingleLabelProDdnsHostname('alice.recued.net.evil.test')).toBe(false);
    // D-176: a disabled zone (recued.cloud) does not match.
    expect(isSingleLabelProDdnsHostname('alice.recued.cloud')).toBe(false);
  });

  it('derives TLS topology from the closed cert source list', () => {
    expect(tlsTopologyForHostnameCertSource('recued_acme')).toBe('server_terminated');
    expect(tlsTopologyForHostnameCertSource('byo_uploaded')).toBe('server_terminated');
    expect(tlsTopologyForHostnameCertSource('byo_external')).toBe('upstream_terminated');
  });

  it('projects safe RPC/list fields without cert blob or verification-token material', () => {
    const projection = projectHostname(row());

    expect(projection).toMatchObject({
      hostname_id: 'host-1',
      hostname: 'alice.example',
      cert_source: 'byo_uploaded',
      cert_fingerprint: 'abc123',
      ownership_status: 'verified',
      verification_method: 'cert_proof',
      enabled: true,
      tls_topology: 'server_terminated',
    });
    expect(projection).not.toHaveProperty('cert_blob_id');
    expect(projection).not.toHaveProperty('verification_token_hash');
    expect(projection).not.toHaveProperty('private_key_pem');
  });

  it('binding gate requires enabled + verified + matching topology', () => {
    expect(canBindHostname(row(), 'server_terminated')).toBe(true);
    expect(canBindHostname(row({ enabled: false }), 'server_terminated')).toBe(false);
    expect(canBindHostname(row({ ownership_status: 'pending' }), 'server_terminated')).toBe(false);
    expect(canBindHostname(row(), 'upstream_terminated')).toBe(false);
  });

  it('registers collection.hostname rpc methods as known local-only methods', () => {
    const methods = [
      'collection.hostname.list',
      'collection.hostname.get',
      'collection.hostname.add',
      'collection.hostname.update',
      'collection.hostname.remove',
      'collection.hostname.verifyOwnership',
    ];

    for (const method of methods) {
      expect(SERVER_RPC_METHOD_SET.has(method), method).toBe(true);
    }
    expect(MCP_RESERVED_RPC_PREFIXES).toContain('collection.hostname.');

    const addRequest = {
      hostname: 'app.example',
      cert_source: 'byo_uploaded',
      verification_method: 'cert_proof',
    } satisfies HostnameAddRequest;
    expect(addRequest.hostname).toBe('app.example');
  });
});
