/** D-125 Phase 2.1 — connection rpc registry tests.
 *
 *  Substrate-only: confirms the core `collection.connection.*`
 *  methods land in `SERVER_RPC_METHODS` + the keyof typing aligns
 *  with `ServerRpcRegistry`. The handler-side end-to-end coverage
 *  lives at `backend/server/src/__tests__/d-125-phase-2-1-
 *  connection-handler.test.ts`. */

import { describe, expect, it } from 'vitest';
import {
  connectionCredentialRejectionCorrection,
  connectionCredentialRejectionTriage,
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
  type ServerRpcRegistry,
} from '../index.js';

describe('D-125 P2.1 — collection.connection.* method registry', () => {
  const expected: Array<keyof ServerRpcRegistry> = [
    'collection.connection.list',
    'collection.connection.suggestSetup',
    'collection.connection.enroll',
    'collection.connection.update',
    'collection.connection.rotateCredentials',
    'collection.connection.credentialRotationStatus',
    'collection.connection.credentialRotationActivity',
    'collection.connection.acknowledgeCredentialRotationSafeStop',
    'collection.connection.delete',
    'collection.connection.probe',
  ];

  it.each(expected)('registers %s in SERVER_RPC_METHODS', (method) => {
    expect((SERVER_RPC_METHODS as readonly string[]).includes(method)).toBe(true);
  });

  it.each(expected)('exposes %s in SERVER_RPC_METHOD_SET', (method) => {
    expect(SERVER_RPC_METHOD_SET.has(method)).toBe(true);
  });

  it('preserves the existing rpc surface (regression check)', () => {
    // A single sentinel from each pre-existing family. Catches an
    // accidental SERVER_RPC_METHODS rewrite that loses prior rows.
    expect(SERVER_RPC_METHOD_SET.has('contact.upsert')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('collection.list')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('collection.service.enroll')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('annotation.write')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('enrichment.upsert')).toBe(true);
  });

  it('does not register a rpc for retired/non-existent methods', () => {
    // Defensive — catches a typo that would create an unhandled
    // method name (future proofing the registry against
    // `collection.connection.subscribe` etc. that aren't in P2.1).
    expect(SERVER_RPC_METHOD_SET.has('collection.connection.subscribe')).toBe(false);
    expect(SERVER_RPC_METHOD_SET.has('collection.connection.invoke')).toBe(false);
  });

  it('maps rejected auth shapes to ordered, secret-free correction fields', () => {
    expect(connectionCredentialRejectionCorrection('bearer')).toEqual({
      auth_type: 'bearer',
      field_keys: ['auth.token'],
    });
    expect(connectionCredentialRejectionCorrection('basic')).toEqual({
      auth_type: 'basic',
      field_keys: ['auth.username', 'auth.password'],
    });
    expect(connectionCredentialRejectionCorrection('header')).toEqual({
      auth_type: 'header',
      field_keys: ['auth.headers'],
    });
    expect(connectionCredentialRejectionCorrection('query')).toEqual({
      auth_type: 'query',
      field_keys: ['auth.param_name', 'auth.value'],
    });
    expect(connectionCredentialRejectionCorrection('oauth2_refresh')).toEqual({
      auth_type: 'oauth2_refresh',
      field_keys: [
        'auth.refresh_token',
        'auth.client_id',
        'auth.client_secret',
        'auth.token_endpoint',
      ],
    });
    expect(
      connectionCredentialRejectionCorrection('oauth2_client_credentials'),
    ).toEqual({
      auth_type: 'oauth2_client_credentials',
      field_keys: [
        'auth.client_id',
        'auth.client_secret',
        'auth.token_endpoint',
        'auth.scope',
      ],
    });
    expect(connectionCredentialRejectionCorrection('atproto_session')).toEqual({
      auth_type: 'atproto_session',
      field_keys: ['auth.identifier', 'auth.app_password'],
    });
    expect(connectionCredentialRejectionCorrection('none')).toBeNull();
  });

  it('maps a bounded rejection stage to canonical endpoint review fields', () => {
    expect(connectionCredentialRejectionTriage(
      'api',
      'oauth2_refresh',
      'credential_exchange',
    )).toEqual({
      reason: 'repeated_auth_rejection',
      stage: 'credential_exchange',
      endpoint_field_keys: ['auth.token_endpoint'],
    });
    expect(connectionCredentialRejectionTriage(
      'api',
      'bearer',
      'provider_probe',
    )).toEqual({
      reason: 'repeated_auth_rejection',
      stage: 'provider_probe',
      endpoint_field_keys: ['config.base_url', 'config.endpoint'],
    });
    expect(connectionCredentialRejectionTriage(
      'api',
      'bearer',
      'provider_probe',
      'regenerate_credential_or_contact_admin',
    )).toEqual({
      reason: 'repeated_auth_rejection',
      stage: 'provider_probe',
      endpoint_field_keys: ['config.base_url', 'config.endpoint'],
      resolution: 'regenerate_credential_or_contact_admin',
    });
    expect(connectionCredentialRejectionTriage(
      'mcp',
      'bearer',
      'provider_probe',
    )?.endpoint_field_keys).toEqual(['config.endpoint']);
    expect(connectionCredentialRejectionTriage(
      'notification',
      'bearer',
      'provider_probe',
    )?.endpoint_field_keys).toEqual([]);
    expect(connectionCredentialRejectionTriage(
      'api',
      'bearer',
      'credential_exchange',
      'regenerate_credential_or_contact_admin',
    )).toBeNull();
    expect(connectionCredentialRejectionTriage(
      'notification',
      'oauth2_refresh',
      'credential_exchange',
    )).toBeNull();
    expect(connectionCredentialRejectionTriage(
      'mcp',
      'atproto_session',
      'credential_exchange',
    )).toBeNull();
  });
});
