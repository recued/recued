/** D-152 P0 — hostname registry SQLite store. */

import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HostnameRegistryError,
  createHostnameRegistryStore,
  ensureHostnameRegistrySchema,
} from '../storage/hostname-registry.js';

const NOW = 1_700_000_000_000;

let db: Database.Database;
let nextId = 0;

const makeStore = () =>
  createHostnameRegistryStore(db, {
    now: () => NOW + nextId,
    newId: () => `host-${++nextId}`,
  });

beforeEach(() => {
  db = new Database(':memory:');
  nextId = 0;
});

afterEach(() => {
  db.close();
});

describe('D-152 P0 hostname registry store', () => {
  it('keeps hostname registry core free of entitlement and billing imports', () => {
    const sources = [
      readFileSync(new URL('../storage/hostname-registry.ts', import.meta.url), 'utf8'),
      readFileSync(
        new URL('../../../../packages/contracts/src/hostname.ts', import.meta.url),
        'utf8',
      ),
    ];

    for (const source of sources) {
      expect(source).not.toMatch(/from\s+['"][^'"]*(entitlements|billing)[^'"]*['"]/);
      expect(source).not.toMatch(/\bpro_tier\b/);
    }
  });

  it('installs the canonical tables and indexes idempotently', () => {
    ensureHostnameRegistrySchema(db);
    ensureHostnameRegistrySchema(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(['cert_blob', 'hostname_registry']);
  });

  it('allows free multi-hostname BYO rows and projects no secret columns', () => {
    const store = makeStore();

    store.upsert({
      server_identity_id: 'server-1',
      hostname: 'App.Example',
      cert_source: 'byo_uploaded',
      cert_blob_id: 'blob-app',
      cert_fingerprint: 'fp-app',
      cert_expires_at: NOW + 86_400_000,
      cert_chain_metadata: { issuer: 'Test CA', subject: 'app.example' },
      verification_method: 'cert_proof',
      verification_token_hash: 'token-hash',
      listener_ports: [443, 8446, 443],
    });
    store.upsert({
      server_identity_id: 'server-1',
      hostname: 'proxy.example',
      cert_source: 'byo_external',
      verification_method: 'dns_txt',
      listener_ports: [443],
    });
    store.upsert({
      server_identity_id: 'server-1',
      hostname: 'hooks.example',
      cert_source: 'byo_uploaded',
      listener_ports: [8448],
    });

    const rows = store.list();
    expect(rows.map((r) => r.hostname)).toEqual([
      'app.example',
      'hooks.example',
      'proxy.example',
    ]);
    expect(rows.find((r) => r.hostname === 'app.example')).toMatchObject({
      cert_source: 'byo_uploaded',
      listener_ports: [443, 8446],
      ownership_status: 'pending',
      enabled: false,
      tls_topology: 'server_terminated',
    });
    expect(rows.find((r) => r.hostname === 'proxy.example')).toMatchObject({
      cert_source: 'byo_external',
      tls_topology: 'upstream_terminated',
    });

    for (const projection of rows) {
      expect(projection).not.toHaveProperty('cert_blob_id');
      expect(projection).not.toHaveProperty('verification_token_hash');
      expect(projection).not.toHaveProperty('private_key_pem');
    }
  });

  it('normalizes hostname uniqueness while preserving the original row id', () => {
    const store = makeStore();
    const first = store.upsert({
      server_identity_id: 'server-1',
      hostname: 'CASE.Example',
      cert_source: 'byo_uploaded',
    });
    const second = store.upsert({
      server_identity_id: 'server-1',
      hostname: 'case.example',
      cert_source: 'byo_external',
    });

    expect(first.hostname_id).toBe('host-1');
    expect(second.hostname_id).toBe('host-1');
    expect(second).toMatchObject({
      hostname: 'case.example',
      cert_source: 'byo_external',
      tls_topology: 'upstream_terminated',
    });
    expect(store.list()).toHaveLength(1);
  });

  it('restricts recued_acme and ddns_managed rows to single-label recued.cloud hostnames', () => {
    const store = makeStore();

    expect(() =>
      store.upsert({
        server_identity_id: 'server-1',
        hostname: 'example.com',
        cert_source: 'recued_acme',
      }),
    ).toThrow(HostnameRegistryError);
    expect(() =>
      store.upsert({
        server_identity_id: 'server-1',
        hostname: 'example.com',
        cert_source: 'byo_uploaded',
        ddns_managed: true,
      }),
    ).toThrow(HostnameRegistryError);

    expect(store.upsert({
      server_identity_id: 'server-1',
      hostname: 'alice.recued.net',
      cert_source: 'recued_acme',
      ddns_managed: true,
    })).toMatchObject({
      hostname: 'alice.recued.net',
      cert_source: 'recued_acme',
      ownership_status: 'verified',
      ddns_managed: true,
      enabled: false,
      tls_topology: 'server_terminated',
    });
  });

  it('gates listener binding on verified ownership, enabled state, and topology', () => {
    const store = makeStore();
    store.upsert({
      server_identity_id: 'server-1',
      hostname: 'app.example',
      cert_source: 'byo_uploaded',
      cert_blob_id: 'blob-app',
    });

    expect(store.lookupBinding('app.example', 'server_terminated')).toBeNull();
    expect(store.setOwnership({
      hostname: 'app.example',
      status: 'verified',
      verification_method: 'cert_proof',
    })).toMatchObject({ ownership_status: 'verified', enabled: false });
    expect(store.lookupBinding('app.example', 'server_terminated')).toBeNull();

    expect(store.setEnabled('app.example', true)).toMatchObject({ enabled: true });
    expect(store.lookupBinding('app.example', 'server_terminated')).toMatchObject({
      hostname_normalized: 'app.example',
      tls_topology: 'server_terminated',
    });
    expect(store.lookupBinding('app.example', 'upstream_terminated')).toBeNull();
  });

  it('routes byo_external only through the upstream-terminated binding path', () => {
    const store = makeStore();
    store.upsert({
      server_identity_id: 'server-1',
      hostname: 'proxy.example',
      cert_source: 'byo_external',
      ownership_status: 'verified',
      enabled: true,
    });

    expect(store.lookupBinding('proxy.example', 'server_terminated')).toBeNull();
    expect(store.lookupBinding('proxy.example', 'upstream_terminated')).toMatchObject({
      hostname_normalized: 'proxy.example',
      tls_topology: 'upstream_terminated',
    });
  });
});
