/** D-148 P1 — Browser Bridge contract types.
 *
 *  Acceptance per spec § P3 (P1 substrate slice):
 *   - BridgeAction enum is the closed list per § A.3.1.
 *   - BridgeErrorCode enumerates the error taxonomy.
 *   - BRIDGE_ALLOWED_CHROME_PERMISSIONS / BRIDGE_PROHIBITED_CHROME_PERMISSIONS
 *     correctly enforce per-permission CI gate.
 *   - BRIDGE_LOCAL_STORAGE_FIELDS is the documented 6-field set.
 *   - isPatternWithinGrantedOrigins enforces the per-domain grant
 *     subset check (three-way intersection per § A.3.4.1).
 */

import { describe, it, expect } from 'vitest';
import {
  BRIDGE_ACTIONS,
  BRIDGE_SURFACE_KINDS,
  BRIDGE_ERROR_CODES,
  BRIDGE_ALLOWED_CHROME_PERMISSIONS,
  BRIDGE_PROHIBITED_CHROME_PERMISSIONS,
  BRIDGE_LOCAL_STORAGE_FIELDS,
  BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS,
  BRIDGE_COMMAND_MAX_TIMEOUT_MS,
  BRIDGE_MAX_QUEUE_DEPTH,
  BRIDGE_IDEMPOTENCY_TTL_MS,
  isPatternWithinGrantedOrigins,
  isCommandWithinIngredientGrant,
  type BridgeIngredientGrant,
  type BridgeIngredientRef,
} from '../bridge.js';

describe('D-148 P1 — BRIDGE_ACTIONS closed list', () => {
  it('matches spec § A.3.1', () => {
    expect([...BRIDGE_ACTIONS].sort()).toEqual([
      'click',
      'extract_table',
      'fill',
      'os_notification',
      'read_dom',
      'screenshot',
      'wait_for_selector',
    ]);
  });
});

describe('D-148 P1 — BRIDGE_SURFACE_KINDS', () => {
  it('publishing/authoring/reading only — messaging permanently rejected', () => {
    expect([...BRIDGE_SURFACE_KINDS].sort()).toEqual(['authoring', 'publishing', 'reading']);
    expect((BRIDGE_SURFACE_KINDS as ReadonlyArray<string>)).not.toContain('messaging');
  });
});

describe('D-148 P1 — BRIDGE_ERROR_CODES', () => {
  it('contains capacity-gap codes', () => {
    expect(BRIDGE_ERROR_CODES).toContain('capacity_gap_logged_in');
    expect(BRIDGE_ERROR_CODES).toContain('capacity_gap_tab_unavailable');
    expect(BRIDGE_ERROR_CODES).toContain('capacity_gap_permission_missing');
  });

  it('contains authority codes (D-169 P0 Slice 2A retired BridgeAuthority signing; the code names persist as the closed taxonomy — `authority_invalid_grant_scope` is the only one the bridge still emits, for the two-way grant intersection)', () => {
    expect(BRIDGE_ERROR_CODES).toContain('authority_invalid');
    expect(BRIDGE_ERROR_CODES).toContain('authority_expired');
    expect(BRIDGE_ERROR_CODES).toContain('authority_invalid_grant_scope');
    expect(BRIDGE_ERROR_CODES).toContain('ingredient_domain_signature_invalid');
  });

  it('contains MV3 lifecycle code', () => {
    expect(BRIDGE_ERROR_CODES).toContain('mv3_lifecycle_killed');
  });

  it('contains the transient queue backpressure code', () => {
    expect(BRIDGE_ERROR_CODES).toContain('queue_full');
  });

  it('codes are unique', () => {
    expect(new Set(BRIDGE_ERROR_CODES).size).toBe(BRIDGE_ERROR_CODES.length);
  });
});

describe('D-148 P1 — BRIDGE_ALLOWED_CHROME_PERMISSIONS', () => {
  it('matches spec § A.3.4 narrow set', () => {
    // D-169 P1 widened the set with `'sidePanel'` for the side-panel
    // viewer per spec § N.5; the parallel ratchet update in this
    // contracts test was missed at landing time + caught by the
    // D-169 P1.5 regression sweep.
    expect([...BRIDGE_ALLOWED_CHROME_PERMISSIONS].sort()).toEqual([
      'alarms',
      'notifications',
      'offscreen',
      'scripting',
      'sidePanel',
      'storage',
      'tabs',
    ]);
  });

  it('does not include host permissions (those are per-domain opt-in)', () => {
    for (const perm of BRIDGE_ALLOWED_CHROME_PERMISSIONS) {
      expect(perm).not.toContain('://');
      expect(perm).not.toBe('<all_urls>');
    }
  });
});

describe('D-148 P1 — BRIDGE_PROHIBITED_CHROME_PERMISSIONS', () => {
  it('explicitly forbids <all_urls>', () => {
    expect(BRIDGE_PROHIBITED_CHROME_PERMISSIONS).toContain('<all_urls>');
  });

  it('forbids high-impact permissions', () => {
    const expected = [
      'cookies',
      'webRequest',
      'webRequestBlocking',
      'history',
      'bookmarks',
      'tabCapture',
      'desktopCapture',
      'pageCapture',
      'proxy',
      'vpnProvider',
      'debugger',
    ];
    for (const perm of expected) {
      expect(BRIDGE_PROHIBITED_CHROME_PERMISSIONS).toContain(perm);
    }
  });

  it('allowed and prohibited sets are disjoint', () => {
    const allowed = new Set(BRIDGE_ALLOWED_CHROME_PERMISSIONS);
    for (const p of BRIDGE_PROHIBITED_CHROME_PERMISSIONS) {
      expect(allowed.has(p)).toBe(false);
    }
  });
});

describe('D-148 P1 + D-169 P0 Slice 2B — BRIDGE_LOCAL_STORAGE_FIELDS', () => {
  it('matches spec § A.3.4 closed list of 8 fields (post-Slice-2B substrate alignment)', () => {
    expect(BRIDGE_LOCAL_STORAGE_FIELDS.length).toBe(8);
    expect([...BRIDGE_LOCAL_STORAGE_FIELDS].sort()).toEqual([
      'cert_pin_state',
      'chrome_permissions_state',
      'idempotency_cache',
      'pair_metadata',
      'pending_outbox',
      'server_public_key',
      'server_url',
      'webclient_token',
    ]);
  });

  it('does NOT carry the retired `bridge_token` field', () => {
    expect((BRIDGE_LOCAL_STORAGE_FIELDS as ReadonlyArray<string>).includes('bridge_token')).toBe(false);
  });
});

describe('D-148 P1 — BRIDGE_* timing constants', () => {
  it('default + max timeout per spec § A.3.1', () => {
    expect(BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(BRIDGE_COMMAND_MAX_TIMEOUT_MS).toBe(60_000);
  });

  it('max queue depth = 32 per spec § A.3.2', () => {
    expect(BRIDGE_MAX_QUEUE_DEPTH).toBe(32);
  });

  it('idempotency TTL = 24h per spec § A.3.3', () => {
    expect(BRIDGE_IDEMPOTENCY_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('D-148 P1 — isCommandWithinIngredientGrant (Codex P1 #2 fold)', () => {
  const ingredient: Pick<BridgeIngredientRef, 'publisher_id' | 'slug' | 'version' | 'domain_allowlist'> = {
    publisher_id: 'recued-core',
    slug: 'draft-email-reader-hubspot',
    version: '1.0.0',
    domain_allowlist: ['*://app.hubspot.com/*'],
  };
  const grant: BridgeIngredientGrant = {
    publisher_id: 'recued-core',
    slug: 'draft-email-reader-hubspot',
    version: '1.0.0',
    granted_origins: ['*://app.hubspot.com/*'],
    granted_at: 1_700_000_000_000,
  };

  it('three-way intersection holds → accepts', () => {
    expect(isCommandWithinIngredientGrant(
      '*://app.hubspot.com/contacts/*',
      ingredient,
      grant,
    )).toBe(true);
  });

  it('rejects when publisher_id mismatch', () => {
    const wrong_pub = { ...grant, publisher_id: 'other-pub' };
    expect(isCommandWithinIngredientGrant(
      '*://app.hubspot.com/*',
      ingredient,
      wrong_pub,
    )).toBe(false);
  });

  it('rejects when slug mismatch', () => {
    const wrong_slug = { ...grant, slug: 'other-slug' };
    expect(isCommandWithinIngredientGrant(
      '*://app.hubspot.com/*',
      ingredient,
      wrong_slug,
    )).toBe(false);
  });

  it('rejects when version mismatch (re-prompt on version change)', () => {
    const wrong_version = { ...grant, version: '2.0.0' };
    expect(isCommandWithinIngredientGrant(
      '*://app.hubspot.com/*',
      ingredient,
      wrong_version,
    )).toBe(false);
  });

  it('rejects when pattern not in ingredient signed allowlist', () => {
    expect(isCommandWithinIngredientGrant(
      '*://linkedin.com/*',
      ingredient,
      grant,
    )).toBe(false);
  });

  it('rejects when pattern in allowlist but not in user grant', () => {
    const narrow_grant = { ...grant, granted_origins: ['*://api.hubspot.com/*'] };
    expect(isCommandWithinIngredientGrant(
      '*://app.hubspot.com/contacts/*',
      ingredient,
      narrow_grant,
    )).toBe(false);
  });
});

describe('D-148 P1 — domain_allowlist_signature field name (Codex P1 #3 fold)', () => {
  it('BridgeIngredientRef shape carries domain_allowlist_signature (not domain_signature)', () => {
    const ingredient: BridgeIngredientRef = {
      slug: 'foo',
      publisher_id: 'recued-core',
      version: '1.0.0',
      surface_kind: 'reading',
      domain_allowlist: ['*://example.com/*'],
      domain_allowlist_signature: 'ED25519_SIG_BASE64',
    };
    expect(ingredient.domain_allowlist_signature).toBe('ED25519_SIG_BASE64');
    expect((ingredient as { domain_signature?: unknown }).domain_signature).toBeUndefined();
  });
});

describe('D-148 P1 — isPatternWithinGrantedOrigins (three-way intersection)', () => {
  it('rejects when no origins granted', () => {
    expect(isPatternWithinGrantedOrigins('*://app.hubspot.com/*', [])).toBe(false);
  });

  it('accepts exact-match', () => {
    expect(
      isPatternWithinGrantedOrigins(
        '*://app.hubspot.com/*',
        ['*://app.hubspot.com/*'],
      ),
    ).toBe(true);
  });

  it('accepts subset path under granted parent', () => {
    expect(
      isPatternWithinGrantedOrigins(
        '*://app.hubspot.com/contacts/*',
        ['*://app.hubspot.com/*'],
      ),
    ).toBe(true);
  });

  it('rejects pattern that escapes granted host', () => {
    expect(
      isPatternWithinGrantedOrigins(
        '*://linkedin.com/*',
        ['*://app.hubspot.com/*'],
      ),
    ).toBe(false);
  });

  it('rejects narrower-host pattern when only specific host granted', () => {
    // Granted '*://app.hubspot.com/*' covers app.hubspot.com.
    // Granted '*://*.hubspot.com/*' would cover app.hubspot.com.
    // Pattern '*://hubspot.com/*' (root domain) is NOT covered by
    // '*://app.hubspot.com/*'.
    expect(
      isPatternWithinGrantedOrigins(
        '*://hubspot.com/*',
        ['*://app.hubspot.com/*'],
      ),
    ).toBe(false);
  });

  it('accepts pattern via wildcard subdomain grant', () => {
    expect(
      isPatternWithinGrantedOrigins(
        '*://app.hubspot.com/*',
        ['*://*.hubspot.com/*'],
      ),
    ).toBe(true);
    expect(
      isPatternWithinGrantedOrigins(
        '*://api.hubspot.com/contacts/*',
        ['*://*.hubspot.com/*'],
      ),
    ).toBe(true);
  });

  it('rejects pattern via narrower-than-grant path subset escape', () => {
    // Granted only /contacts/* — pattern at /email/ should reject.
    expect(
      isPatternWithinGrantedOrigins(
        '*://app.hubspot.com/email/*',
        ['*://app.hubspot.com/contacts/*'],
      ),
    ).toBe(false);
  });
});
