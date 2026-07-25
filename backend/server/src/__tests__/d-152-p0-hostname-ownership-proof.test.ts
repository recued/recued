/** D-152 P0 - hostname ownership-proof state machine. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyHostnameOwnershipProof } from '../hostname/ownership-proof.js';
import { createHostnameSniBindingLookup } from '../hostname/sni-dispatch.js';
import { createHostnameRegistryStore } from '../storage/hostname-registry.js';

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

describe('D-152 P0 hostname ownership-proof state machine', () => {
  it('transitions cert_proof BYO-upload rows to verified when the cert matched', () => {
    const store = makeStore();
    store.upsert({
      server_identity_id: 'server-1',
      hostname: 'App.Example',
      cert_source: 'byo_uploaded',
      verification_method: 'cert_proof',
    });

    const result = applyHostnameOwnershipProof(store, {
      hostname: 'app.example',
      method: 'cert_proof',
      cert_matches_hostname: true,
    });

    expect(result).toMatchObject({
      ok: true,
      hostname: 'app.example',
      method: 'cert_proof',
      status: 'verified',
    });
    expect(store.get('app.example')).toMatchObject({
      ownership_status: 'verified',
      verified_at: NOW + 1,
      verification_method: 'cert_proof',
    });
  });

  it('records failed for http_token mismatch and verified for a later matching token', () => {
    const store = makeStore();
    store.upsert({
      server_identity_id: 'server-1',
      hostname: 'token.example',
      cert_source: 'byo_external',
      verification_method: 'http_token',
      verification_token_hash: 'sha256:expected',
    });

    expect(applyHostnameOwnershipProof(store, {
      hostname: 'token.example',
      method: 'http_token',
      observed_token_hash: 'sha256:wrong',
    })).toMatchObject({
      ok: true,
      status: 'failed',
    });
    const failedRow = store.get('token.example');
    expect(failedRow).toMatchObject({
      ownership_status: 'failed',
      verification_token_hash: 'sha256:expected',
    });
    expect(failedRow?.verified_at).toBeUndefined();

    expect(applyHostnameOwnershipProof(store, {
      hostname: 'token.example',
      method: 'http_token',
      observed_token_hash: 'sha256:expected',
    })).toMatchObject({
      ok: true,
      status: 'verified',
    });
    expect(store.get('token.example')).toMatchObject({
      ownership_status: 'verified',
      verified_at: NOW + 1,
      verification_token_hash: 'sha256:expected',
    });
  });

  it('keeps dns_txt token proofs closed over the configured method and token hash', () => {
    const store = makeStore();
    store.upsert({
      server_identity_id: 'server-1',
      hostname: 'dns.example',
      cert_source: 'byo_uploaded',
      verification_method: 'dns_txt',
      verification_token_hash: 'sha256:dns',
    });

    expect(applyHostnameOwnershipProof(store, {
      hostname: 'dns.example',
      method: 'http_token',
      observed_token_hash: 'sha256:dns',
    })).toMatchObject({
      ok: false,
      code: 'method_mismatch',
      expected_method: 'dns_txt',
    });

    expect(applyHostnameOwnershipProof(store, {
      hostname: 'dns.example',
      method: 'dns_txt',
      observed_token_hash: 'sha256:dns',
    })).toMatchObject({
      ok: true,
      status: 'verified',
    });
  });

  it('rejects incompatible proof methods before mutating ownership', () => {
    const store = makeStore();
    store.upsert({
      server_identity_id: 'server-1',
      hostname: 'proxy.example',
      cert_source: 'byo_external',
      verification_method: 'dns_txt',
      verification_token_hash: 'sha256:dns',
    });

    expect(applyHostnameOwnershipProof(store, {
      hostname: 'proxy.example',
      method: 'cert_proof',
      cert_matches_hostname: true,
    })).toMatchObject({
      ok: false,
      code: 'incompatible_proof_method',
      cert_source: 'byo_external',
    });
    expect(store.get('proxy.example')).toMatchObject({
      ownership_status: 'pending',
      verification_method: 'dns_txt',
    });
  });

  it('adapts only enabled and verified rows into SNI bindings', () => {
    const store = makeStore();
    store.upsert({
      server_identity_id: 'server-1',
      hostname: 'ready.example',
      cert_source: 'byo_uploaded',
      ownership_status: 'verified',
      enabled: true,
    });
    store.upsert({
      server_identity_id: 'server-1',
      hostname: 'pending.example',
      cert_source: 'byo_uploaded',
      ownership_status: 'pending',
      enabled: true,
    });
    store.upsert({
      server_identity_id: 'server-1',
      hostname: 'proxy.example',
      cert_source: 'byo_external',
      ownership_status: 'verified',
      enabled: true,
    });

    const lookup = createHostnameSniBindingLookup(store);
    expect(lookup('READY.EXAMPLE')).toEqual({
      hostname: 'ready.example',
      cert_source: 'byo_uploaded',
      tls_topology: 'server_terminated',
    });
    expect(lookup('pending.example')).toBeNull();
    expect(lookup('not a host')).toBeNull();
    expect(lookup('proxy.example')).toEqual({
      hostname: 'proxy.example',
      cert_source: 'byo_external',
      tls_topology: 'upstream_terminated',
    });
  });
});
