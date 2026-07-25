/** D-151 follow-on — bearer-derived paired-instance identity.
 *
 *  Webclients authenticate bearer-only and never send a `register`
 *  message (D-156), so `WsClient.instance_id` stays null and every
 *  instance-gated rpc (`reception.*`, `collection.hostname.*`, …)
 *  rejected them as an "unregistered connection". The fix derives a
 *  gate-only identity from the verified token's `metadata.instance_id`
 *  (`deriveBearerInstanceId`) and resolves it for the rpc gate at
 *  dispatch (`resolveGatedClientInstanceId`) WITHOUT touching the live
 *  `clients` map entry — so `instance_id`-keyed routing/limit paths stay
 *  unaffected. These two pure helpers carry the whole decision; this
 *  file pins them. */

import { describe, it, expect } from 'vitest';

import {
  deriveBearerInstanceId,
  resolveGatedClientInstanceId,
} from '../ws-server.js';

const NEVER_REVOKED = (): boolean => false;
const ALWAYS_REVOKED = (): boolean => true;

describe('deriveBearerInstanceId', () => {
  it('returns the instance id for a non-empty, non-revoked string', () => {
    expect(deriveBearerInstanceId('inst-123', NEVER_REVOKED)).toBe('inst-123');
  });

  it('returns null when the instance is revoked (mirrors the register-path gate)', () => {
    // HIGH#1 — a revoked device's client_tokens row survives pair.revoke;
    // the surviving bearer must NOT re-derive a usable identity.
    expect(deriveBearerInstanceId('inst-123', ALWAYS_REVOKED)).toBeNull();
  });

  it('passes the exact id to the revoke predicate', () => {
    const seen: string[] = [];
    deriveBearerInstanceId('inst-xyz', (id) => {
      seen.push(id);
      return false;
    });
    expect(seen).toEqual(['inst-xyz']);
  });

  it('returns null for absent / blank / non-string metadata', () => {
    expect(deriveBearerInstanceId(undefined, NEVER_REVOKED)).toBeNull();
    expect(deriveBearerInstanceId(null, NEVER_REVOKED)).toBeNull();
    expect(deriveBearerInstanceId('', NEVER_REVOKED)).toBeNull();
    expect(deriveBearerInstanceId(42, NEVER_REVOKED)).toBeNull();
    expect(deriveBearerInstanceId({ instance_id: 'x' }, NEVER_REVOKED)).toBeNull();
  });
});

describe('resolveGatedClientInstanceId', () => {
  it('uses an explicit instance_id (registered bridge/extension) unchanged', () => {
    expect(
      resolveGatedClientInstanceId({ instance_id: 'ext-1', token_instance_id: null }),
    ).toBe('ext-1');
  });

  it('falls back to token_instance_id for a bearer-only webclient (null instance_id)', () => {
    expect(
      resolveGatedClientInstanceId({ instance_id: null, token_instance_id: 'wc-1' }),
    ).toBe('wc-1');
  });

  it('prefers the explicit instance_id over token_instance_id', () => {
    // A registered client keeps its register()-claimed identity; the
    // token-derived value never overrides it.
    expect(
      resolveGatedClientInstanceId({ instance_id: 'ext-1', token_instance_id: 'wc-1' }),
    ).toBe('ext-1');
  });

  it('returns null when neither is present (unregistered, no token identity → gate rejects)', () => {
    expect(
      resolveGatedClientInstanceId({ instance_id: null, token_instance_id: null }),
    ).toBeNull();
    expect(resolveGatedClientInstanceId({ instance_id: null })).toBeNull();
  });
});
