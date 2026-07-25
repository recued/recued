/** D-177 P4 / D-187 — the session-grant offer resolver over the in-code seeds.
 *
 *  The policy-matrix override row + its store-side machinery (the put-path floor
 *  guard, the session_grant_* lattice, the policy_matrix_cell value_shape, the
 *  BASELINE seed cells) were retired with the matrix in D-187 slice 6; the offer
 *  now resolves from the in-code SESSION_GRANT_DEFAULT_SEEDS directly. */

import { describe, expect, it } from 'vitest';

import {
  CHAT_SESSION_GRANT_DEFAULTS,
  MCP_SESSION_GRANT_DEFAULTS,
  MESSENGER_SESSION_GRANT_DEFAULTS,
  SESSION_GRANT_RISK_TIERS,
  resolveSessionGrantOffer,
} from '../session-grant.js';

describe('resolveSessionGrantOffer', () => {
  it('resolves the in-code seed (the policy-matrix override row was retired)', () => {
    expect(SESSION_GRANT_RISK_TIERS).toEqual(['write', 'admin']);
    for (const risk_tier of ['write', 'admin'] as const) {
      expect(
        resolveSessionGrantOffer({
          channel: 'chat',
          actor: 'user_self',
          risk_tier,
        }),
      ).toEqual({
        ttl_ms: CHAT_SESSION_GRANT_DEFAULTS.ttl_ms,
        max_uses: CHAT_SESSION_GRANT_DEFAULTS.max_uses,
        risk_tier,
      });
    }
    for (const risk_tier of ['read', 'destructive', undefined, 'bogus'] as const) {
      expect(
        resolveSessionGrantOffer({
          channel: 'chat',
          actor: 'user_self',
          risk_tier,
        }),
      ).toBeUndefined();
    }
    expect(
      resolveSessionGrantOffer({
        channel: 'messenger',
        actor: 'contracted_user',
        risk_tier: 'write',
      }),
    ).toBeUndefined();
  });

  it('offers on the P5-seeded messenger owner and mcp contracted cells without a scan', () => {
    expect(
      resolveSessionGrantOffer({
        channel: 'messenger',
        actor: 'user_self',
        risk_tier: 'write',
      }),
    ).toEqual({
      ttl_ms: MESSENGER_SESSION_GRANT_DEFAULTS.ttl_ms,
      max_uses: MESSENGER_SESSION_GRANT_DEFAULTS.max_uses,
      risk_tier: 'write',
    });
    expect(
      resolveSessionGrantOffer({
        channel: 'mcp',
        actor: 'contracted_user',
        risk_tier: 'admin',
      }),
    ).toEqual({
      ttl_ms: MCP_SESSION_GRANT_DEFAULTS.ttl_ms,
      max_uses: MCP_SESSION_GRANT_DEFAULTS.max_uses,
      risk_tier: 'admin',
    });
  });
});
