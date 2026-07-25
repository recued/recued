/** D-148 P4 — webclient contract surface. */

import { describe, expect, it } from 'vitest';
import {
  APPROVAL_AUTO_DENY_DEFAULT_MS,
  APPROVAL_NONCE_ERROR_CODES,
  APPROVAL_NONCE_TTL_MS,
  WEBCLIENT_FORBIDDEN_IMPORT_PREFIXES,
  WEBCLIENT_INDEXED_DB_NAME,
  WEBCLIENT_LOCAL_STORAGE_FIELDS,
  WEBCLIENT_OBJECT_STORES,
  WEBCLIENT_SNAPSHOT_SURFACES,
  isWebclientSnapshotSurface,
} from '../webclient.js';

describe('D-148 P4 — webclient contract', () => {
  it('5-field local storage closed list', () => {
    expect(WEBCLIENT_LOCAL_STORAGE_FIELDS.length).toBe(5);
    expect([...WEBCLIENT_LOCAL_STORAGE_FIELDS].sort()).toEqual([
      'cert_pin_state',
      'pair_metadata',
      'server_public_key',
      'server_url',
      'webclient_token',
    ]);
  });

  it('snapshot surfaces enumerate the 5 documented kinds', () => {
    expect([...WEBCLIENT_SNAPSHOT_SURFACES].sort()).toEqual([
      'inbox',
      'internal_steps',
      'settings.connections',
      'settings.exposure',
      'settings.key_health',
    ]);
  });

  it('isWebclientSnapshotSurface predicate', () => {
    expect(isWebclientSnapshotSurface('inbox')).toBe(true);
    expect(isWebclientSnapshotSurface('not-a-surface')).toBe(false);
    expect(isWebclientSnapshotSurface(undefined)).toBe(false);
    expect(isWebclientSnapshotSurface(null)).toBe(false);
  });

  it('approval nonce constants', () => {
    expect(APPROVAL_NONCE_TTL_MS).toBe(10 * 60 * 1000);
    expect(APPROVAL_AUTO_DENY_DEFAULT_MS).toBe(5 * 60 * 1000);
    expect([...APPROVAL_NONCE_ERROR_CODES].sort()).toEqual([
      'approval_nonce_consumed',
      'approval_nonce_expired',
      'approval_nonce_invalid',
      'approval_nonce_mismatched_approval',
      'approval_nonce_mismatched_client',
    ]);
  });

  it('forbidden import prefix list covers engine + recipes + storage + cache + scheduler + marketplace', () => {
    expect([...WEBCLIENT_FORBIDDEN_IMPORT_PREFIXES].sort()).toEqual([
      '@recued/cache',
      '@recued/engine',
      '@recued/marketplace',
      '@recued/recipes',
      '@recued/scheduler',
      '@recued/storage',
    ]);
  });

  it('IDB substrate constants', () => {
    expect(WEBCLIENT_INDEXED_DB_NAME).toBe('recued.webclient.v1');
    expect([...WEBCLIENT_OBJECT_STORES].sort()).toEqual([
      'recued.webclient.local_storage',
      'recued.webclient.token_key',
    ]);
  });
});
