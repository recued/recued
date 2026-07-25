/** D-148 Wave 3 (sub-phase W3.1) — Path-routing contracts substrate.
 *
 *  Covers the additive path-routing types + pure helpers introduced
 *  alongside the legacy 5-profile model (Amendment 2026-05-11). The
 *  legacy types stay in production; later Wave 3 sub-phases swap the
 *  state machine + listener-set onto this substrate.
 *
 *  Invariants under test:
 *    - PATH_ROLES: closed list of 5 (health / ws / mcp / webhooks /
 *      reception) — every entry unique; PATH_FOR_ROLE keys match.
 *    - EXPOSURE_PRESETS: closed list of 3 (lan_only / public /
 *      maintenance) — no overlap with the legacy 5-profile names by
 *      accident (lan_only is shared by name, but the resolution shape
 *      under the new model differs from the legacy table).
 *    - EXPOSURE_PRESET_PATH_MAP: 3 presets × 5 paths = 15 deterministic
 *      entries; mcp.public is FALSE in every preset shape (the gate
 *      is the only way to flip it true).
 *    - applyPreset threads the acknowledgement: public preset + valid
 *      ack → mcp.public=true; public preset + missing ack → mcp.public
 *      stays false (matches § A.7.2 baseline behavior).
 *    - deriveLabel: round-trips every preset; mcp.public=true with
 *      otherwise-public shape still labels as `'public'`; any deviation
 *      from a preset shape labels as `'custom'`.
 *    - applyPathResolution: pure (input untouched); only the targeted
 *      path mutates.
 *    - requiredWsLockoutPhrase: returns null when target has any bit
 *      true; returns 'disconnect webclients' when ≥ 1 ws connection
 *      AND target = { lan:false, public:false }; returns 'disable ws'
 *      when 0 connections.
 *    - requiresPublicMcpAcknowledgementForResolution: true iff path =
 *      mcp AND next.public AND !current.public; false on demotion.
 *    - anyPathLan / anyPathPublic: aggregate over the path table.
 *    - NETWORK_ERROR_CODES widened with path_unknown +
 *      ws_lockout_unconfirmed + ws_lockout_phrase_mismatch +
 *      preset_unknown; legacy codes preserved (no breaking change).
 */

import { describe, it, expect } from 'vitest';
import {
  PATH_ROLES,
  PATH_FOR_ROLE,
  matchesPathRole,
  EXPOSURE_PRESETS,
  EXPOSURE_PRESET_PATH_MAP,
  WS_LOCKOUT_DISCONNECT_PHRASE,
  WS_LOCKOUT_DISABLE_PHRASE,
  WS_LOCKOUT_PHRASES,
  DEFAULT_PATH_RESOLUTION,
  applyPreset,
  applyPathResolution,
  deriveLabel,
  requiredWsLockoutPhrase,
  isValidWsLockoutPhrase,
  requiresPublicMcpAcknowledgementForResolution,
  anyPathLan,
  anyPathPublic,
  NETWORK_ERROR_CODES,
  type PathRole,
  type PathResolution,
  type ExposurePreset,
  type PublicMcpAcknowledgement,
} from '../network.js';

const ACK_OFF: PublicMcpAcknowledgement = { acknowledged: false };
const ACK_ON: PublicMcpAcknowledgement = {
  acknowledged: true,
  free_text_confirmation: 'enable public MCP',
};
const ACK_MALFORMED: PublicMcpAcknowledgement = { acknowledged: true };

describe('D-148 W3.1 — PATH_ROLES closed list', () => {
  it('enumerates exactly 9 distinct path roles', () => {
    expect(PATH_ROLES.length).toBe(9);
    expect(new Set(PATH_ROLES).size).toBe(9);
  });

  it('canonical order matches spec § A.6 table (+ D-165 oauth, D-158 ask, D-196 llm_gateway)', () => {
    expect([...PATH_ROLES]).toEqual([
      'health',
      'ws',
      'mcp',
      'llm_gateway',
      'webhooks',
      'reception',
      'oauth',
      'ask',
      'webclient',
    ]);
  });

  it('PATH_FOR_ROLE keys match the closed list 1:1', () => {
    expect(Object.keys(PATH_FOR_ROLE).sort()).toEqual([...PATH_ROLES].sort());
  });

  it('canonical path strings start with / and have no trailing slash', () => {
    for (const role of PATH_ROLES) {
      const path = PATH_FOR_ROLE[role];
      expect(path.startsWith('/')).toBe(true);
      expect(path.endsWith('/')).toBe(false);
    }
  });
});

describe('D-148 W3.1 — EXPOSURE_PRESETS closed list', () => {
  it('enumerates exactly 3 distinct presets', () => {
    expect(EXPOSURE_PRESETS.length).toBe(3);
    expect(new Set(EXPOSURE_PRESETS).size).toBe(3);
  });

  it('canonical order matches spec § A.7.1', () => {
    expect([...EXPOSURE_PRESETS]).toEqual(['lan_only', 'public', 'maintenance']);
  });
});

describe('D-148 W3.1 — EXPOSURE_PRESET_PATH_MAP', () => {
  it('3 presets × 9 paths = 27 deterministic entries', () => {
    let count = 0;
    for (const preset of EXPOSURE_PRESETS) {
      for (const role of PATH_ROLES) {
        const entry = EXPOSURE_PRESET_PATH_MAP[preset][role];
        expect(typeof entry.lan).toBe('boolean');
        expect(typeof entry.public).toBe('boolean');
        count++;
      }
    }
    expect(count).toBe(27);
  });

  it('lan_only: every path lan-only-or-off; nothing public', () => {
    for (const role of PATH_ROLES) {
      expect(EXPOSURE_PRESET_PATH_MAP.lan_only[role].public).toBe(false);
    }
    expect(EXPOSURE_PRESET_PATH_MAP.lan_only.health.lan).toBe(true);
    expect(EXPOSURE_PRESET_PATH_MAP.lan_only.ws.lan).toBe(true);
    expect(EXPOSURE_PRESET_PATH_MAP.lan_only.mcp.lan).toBe(true);
    expect(EXPOSURE_PRESET_PATH_MAP.lan_only.llm_gateway.lan).toBe(true);
    expect(EXPOSURE_PRESET_PATH_MAP.lan_only.webhooks.lan).toBe(false);
    expect(EXPOSURE_PRESET_PATH_MAP.lan_only.reception.lan).toBe(false);
    expect(EXPOSURE_PRESET_PATH_MAP.lan_only.oauth.lan).toBe(false);
  });

  it('public: everything lan+public EXCEPT mcp.public=false (gate-only)', () => {
    expect(EXPOSURE_PRESET_PATH_MAP.public.health).toEqual({ lan: true, public: true });
    expect(EXPOSURE_PRESET_PATH_MAP.public.ws).toEqual({ lan: true, public: true });
    expect(EXPOSURE_PRESET_PATH_MAP.public.mcp).toEqual({ lan: true, public: false });
    expect(EXPOSURE_PRESET_PATH_MAP.public.llm_gateway).toEqual({ lan: true, public: true });
    expect(EXPOSURE_PRESET_PATH_MAP.public.webhooks).toEqual({ lan: true, public: true });
    expect(EXPOSURE_PRESET_PATH_MAP.public.reception).toEqual({ lan: true, public: true });
    // D-165 slice 3 — oauth is served by the public preset now the end-to-end
    // flow is complete (cross-origin CORS + owner-bound claim rpc + webclient
    // dialog), so advertising the callback surface no longer offers a dead-end.
    expect(EXPOSURE_PRESET_PATH_MAP.public.oauth).toEqual({ lan: true, public: true });
  });

  it('mcp.public is FALSE in every preset shape — gate is the only path', () => {
    for (const preset of EXPOSURE_PRESETS) {
      expect(EXPOSURE_PRESET_PATH_MAP[preset].mcp.public).toBe(false);
    }
  });

  it('maintenance: every path lan=false AND public=false', () => {
    for (const role of PATH_ROLES) {
      expect(EXPOSURE_PRESET_PATH_MAP.maintenance[role]).toEqual({
        lan: false,
        public: false,
      });
    }
  });
});

describe('D-148 W3.1 — applyPreset', () => {
  it('lan_only ignores acknowledgement (no mcp.public to flip)', () => {
    const off = applyPreset('lan_only', ACK_OFF);
    const on = applyPreset('lan_only', ACK_ON);
    expect(off).toEqual(on);
    expect(off.mcp).toEqual({ lan: true, public: false });
  });

  it('public + unacknowledged: mcp.public stays false', () => {
    const out = applyPreset('public', ACK_OFF);
    expect(out.mcp).toEqual({ lan: true, public: false });
    expect(out.ws).toEqual({ lan: true, public: true });
    expect(out.webhooks).toEqual({ lan: true, public: true });
  });

  it('public + acknowledged: mcp.public flips to true', () => {
    const out = applyPreset('public', ACK_ON);
    expect(out.mcp).toEqual({ lan: true, public: true });
    expect(out.ws).toEqual({ lan: true, public: true });
  });

  it('public + malformed ack (acknowledged:true, no phrase): mcp.public stays false', () => {
    const out = applyPreset('public', ACK_MALFORMED);
    expect(out.mcp).toEqual({ lan: true, public: false });
  });

  it('maintenance ignores acknowledgement entirely', () => {
    const off = applyPreset('maintenance', ACK_OFF);
    const on = applyPreset('maintenance', ACK_ON);
    expect(off).toEqual(on);
    for (const role of PATH_ROLES) {
      expect(off[role]).toEqual({ lan: false, public: false });
    }
  });

  it('output is a deep copy — mutating the result leaves the map untouched', () => {
    const out = applyPreset('lan_only', ACK_OFF);
    out.health.lan = false;
    expect(EXPOSURE_PRESET_PATH_MAP.lan_only.health.lan).toBe(true);
  });
});

describe('D-148 W3.1 — applyPathResolution', () => {
  const baseline: Record<PathRole, PathResolution> = {
    health: { lan: true, public: false },
    ws: { lan: true, public: false },
    mcp: { lan: true, public: false },
    llm_gateway: { lan: true, public: false },
    webhooks: { lan: false, public: false },
    reception: { lan: false, public: false },
    oauth: { lan: false, public: false },
    ask: { lan: false, public: false },
    webclient: { lan: true, public: false },
  };

  it('mutates only the targeted path', () => {
    const out = applyPathResolution(baseline, 'webhooks', { lan: true, public: true });
    expect(out.webhooks).toEqual({ lan: true, public: true });
    expect(out.health).toEqual(baseline.health);
    expect(out.ws).toEqual(baseline.ws);
    expect(out.mcp).toEqual(baseline.mcp);
    expect(out.reception).toEqual(baseline.reception);
  });

  it('does not mutate the input table', () => {
    const before = JSON.stringify(baseline);
    applyPathResolution(baseline, 'webhooks', { lan: true, public: true });
    expect(JSON.stringify(baseline)).toBe(before);
  });

  it('returns a new table even when resolution unchanged (immutable contract)', () => {
    const out = applyPathResolution(baseline, 'webhooks', { lan: false, public: false });
    expect(out).not.toBe(baseline);
    expect(out.webhooks).toEqual(baseline.webhooks);
  });
});

describe('D-148 W3.1 — deriveLabel (ack-aware; Codex P2 #1 fold)', () => {
  it('round-trips lan_only preset', () => {
    expect(deriveLabel(applyPreset('lan_only', ACK_OFF), ACK_OFF)).toBe('lan_only');
    expect(deriveLabel(applyPreset('lan_only', ACK_ON), ACK_ON)).toBe('lan_only');
  });

  it('round-trips public preset against matching ack state', () => {
    expect(deriveLabel(applyPreset('public', ACK_OFF), ACK_OFF)).toBe('public');
    expect(deriveLabel(applyPreset('public', ACK_ON), ACK_ON)).toBe('public');
  });

  it('round-trips maintenance preset', () => {
    expect(deriveLabel(applyPreset('maintenance', ACK_OFF), ACK_OFF)).toBe('maintenance');
    expect(deriveLabel(applyPreset('maintenance', ACK_ON), ACK_ON)).toBe('maintenance');
  });

  it('returns custom when a single path toggle drifts from any preset', () => {
    const drifted = applyPathResolution(
      applyPreset('lan_only', ACK_OFF),
      'webhooks',
      { lan: true, public: false },
    );
    expect(deriveLabel(drifted, ACK_OFF)).toBe('custom');
  });

  it('returns custom for mcp.public=true with otherwise-lan_only shape', () => {
    const oddball = applyPathResolution(
      applyPreset('lan_only', ACK_OFF),
      'mcp',
      { lan: true, public: true },
    );
    expect(deriveLabel(oddball, ACK_OFF)).toBe('custom');
    expect(deriveLabel(oddball, ACK_ON)).toBe('custom');
  });

  it('public preset with mcp.public deliberately true under valid ack labels public', () => {
    const acked = applyPreset('public', ACK_ON);
    expect(acked.mcp).toEqual({ lan: true, public: true });
    expect(deriveLabel(acked, ACK_ON)).toBe('public');
  });

  it('ack=on + everything-public-except-mcp.public-demoted → custom (Codex P2 #1)', () => {
    // Scenario: user applies the public preset under valid ack
    // (mcp.public goes true), then deliberately demotes only
    // /mcp.public back to false while keeping the rest public-shaped.
    // The earlier mcp-blind comparator labeled this as `'public'`,
    // erasing the user's intentional drift. Codex P2 #1 fold: this
    // must label as `'custom'` so the UI can distinguish intentional
    // public-except-MCP from the unack'd public baseline.
    const drifted = applyPathResolution(
      applyPreset('public', ACK_ON),
      'mcp',
      { lan: true, public: false },
    );
    expect(drifted.mcp).toEqual({ lan: true, public: false });
    expect(drifted.ws).toEqual({ lan: true, public: true });
    expect(deriveLabel(drifted, ACK_ON)).toBe('custom');
  });

  it('ack=off + everything-public-except-mcp.public-false → public (unack baseline)', () => {
    // Mirror of the previous case under missing ack: the public-preset
    // baseline (mcp.public=false) matches the unack'd shape exactly,
    // so the label is `'public'` even though MCP is locally off. The
    // ack state is what flips the interpretation.
    const baseline = applyPreset('public', ACK_OFF);
    expect(baseline.mcp).toEqual({ lan: true, public: false });
    expect(deriveLabel(baseline, ACK_OFF)).toBe('public');
  });

  it('cross-ack shape: applyPreset(public, ACK_OFF) graded under ACK_ON → custom', () => {
    // User sat in the unack public baseline (mcp.public=false), then
    // acknowledged public MCP without re-clicking the preset. Their
    // shape now differs from the ack-aware public preset shape
    // (which expects mcp.public=true), so the label flips to custom.
    const shape = applyPreset('public', ACK_OFF);
    expect(deriveLabel(shape, ACK_ON)).toBe('custom');
  });
});

describe('D-148 W3.1 — /ws lockout phrase helpers', () => {
  it('closed list of two phrases', () => {
    expect(WS_LOCKOUT_PHRASES.length).toBe(2);
    expect(WS_LOCKOUT_PHRASES).toContain(WS_LOCKOUT_DISCONNECT_PHRASE);
    expect(WS_LOCKOUT_PHRASES).toContain(WS_LOCKOUT_DISABLE_PHRASE);
  });

  it('returns null when target keeps at least one bit true', () => {
    expect(
      requiredWsLockoutPhrase({
        next_resolution: { lan: true, public: false },
        active_ws_connections: 5,
      }),
    ).toBeNull();
    expect(
      requiredWsLockoutPhrase({
        next_resolution: { lan: false, public: true },
        active_ws_connections: 0,
      }),
    ).toBeNull();
  });

  it('returns disconnect-webclients phrase when ≥1 active and target fully off', () => {
    expect(
      requiredWsLockoutPhrase({
        next_resolution: { lan: false, public: false },
        active_ws_connections: 1,
      }),
    ).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
  });

  it('returns disable-ws phrase when zero active and target fully off', () => {
    expect(
      requiredWsLockoutPhrase({
        next_resolution: { lan: false, public: false },
        active_ws_connections: 0,
      }),
    ).toBe(WS_LOCKOUT_DISABLE_PHRASE);
  });

  it('isValidWsLockoutPhrase: whitespace-insensitive at edges, case-exact in middle', () => {
    expect(isValidWsLockoutPhrase('disconnect webclients', WS_LOCKOUT_DISCONNECT_PHRASE)).toBe(true);
    expect(isValidWsLockoutPhrase('  disconnect webclients  ', WS_LOCKOUT_DISCONNECT_PHRASE)).toBe(true);
    expect(isValidWsLockoutPhrase('Disconnect Webclients', WS_LOCKOUT_DISCONNECT_PHRASE)).toBe(false);
    expect(isValidWsLockoutPhrase('disable ws', WS_LOCKOUT_DISABLE_PHRASE)).toBe(true);
    // Wrong phrase against the other required type
    expect(isValidWsLockoutPhrase('disable ws', WS_LOCKOUT_DISCONNECT_PHRASE)).toBe(false);
  });
});

describe('D-148 W3.1 — requiresPublicMcpAcknowledgementForResolution', () => {
  it('true iff path=mcp + next.public=true + current.public=false', () => {
    expect(
      requiresPublicMcpAcknowledgementForResolution({
        path: 'mcp',
        next_resolution: { lan: true, public: true },
        current_resolution: { lan: true, public: false },
      }),
    ).toBe(true);
  });

  it('false when path is not mcp', () => {
    expect(
      requiresPublicMcpAcknowledgementForResolution({
        path: 'webhooks',
        next_resolution: { lan: true, public: true },
        current_resolution: { lan: true, public: false },
      }),
    ).toBe(false);
  });

  it('false when demoting mcp.public from true to false', () => {
    expect(
      requiresPublicMcpAcknowledgementForResolution({
        path: 'mcp',
        next_resolution: { lan: true, public: false },
        current_resolution: { lan: true, public: true },
      }),
    ).toBe(false);
  });

  it('false when mcp.public stays true (idempotent)', () => {
    expect(
      requiresPublicMcpAcknowledgementForResolution({
        path: 'mcp',
        next_resolution: { lan: true, public: true },
        current_resolution: { lan: true, public: true },
      }),
    ).toBe(false);
  });
});

describe('D-148 W3.1 — anyPathLan / anyPathPublic', () => {
  it('anyPathLan true when at least one path has lan=true', () => {
    expect(anyPathLan(applyPreset('lan_only', ACK_OFF))).toBe(true);
    expect(anyPathLan(applyPreset('public', ACK_OFF))).toBe(true);
    expect(anyPathLan(applyPreset('maintenance', ACK_OFF))).toBe(false);
  });

  it('anyPathPublic true when at least one path has public=true', () => {
    expect(anyPathPublic(applyPreset('lan_only', ACK_OFF))).toBe(false);
    expect(anyPathPublic(applyPreset('public', ACK_OFF))).toBe(true);
    expect(anyPathPublic(applyPreset('maintenance', ACK_OFF))).toBe(false);
  });

  it('anyPathPublic flips true once any single path public bit toggles', () => {
    const cusp = applyPathResolution(
      applyPreset('lan_only', ACK_OFF),
      'webhooks',
      { lan: false, public: true },
    );
    expect(anyPathPublic(cusp)).toBe(true);
  });
});

describe('D-148 W3.1 — DEFAULT_PATH_RESOLUTION', () => {
  it('matches the lan_only preset shape under unack default', () => {
    expect(DEFAULT_PATH_RESOLUTION).toEqual(applyPreset('lan_only', ACK_OFF));
  });

  it('derived label of the default is lan_only (ack absent at first boot)', () => {
    expect(deriveLabel(DEFAULT_PATH_RESOLUTION, ACK_OFF)).toBe('lan_only');
  });
});

describe('D-148 W3.1 — NETWORK_ERROR_CODES widening', () => {
  it('adds the four path-routing codes', () => {
    expect(NETWORK_ERROR_CODES).toContain('path_unknown');
    expect(NETWORK_ERROR_CODES).toContain('preset_unknown');
    expect(NETWORK_ERROR_CODES).toContain('ws_lockout_unconfirmed');
    expect(NETWORK_ERROR_CODES).toContain('ws_lockout_phrase_mismatch');
  });

  it('public-MCP + preset gate codes preserved through W3.5 retirement', () => {
    expect(NETWORK_ERROR_CODES).toContain('public_mcp_not_acknowledged');
    expect(NETWORK_ERROR_CODES).toContain('public_mcp_phrase_mismatch');
    // W3.5 renames profile_* → preset_* (legacy 5-profile types retired).
    expect(NETWORK_ERROR_CODES).toContain('preset_unachievable_no_ddns');
    // Legacy 5-profile error codes are GONE.
    expect(NETWORK_ERROR_CODES).not.toContain('profile_unknown' as never);
    expect(NETWORK_ERROR_CODES).not.toContain('profile_unachievable_no_ddns' as never);
  });

  it('closed list has no duplicates', () => {
    expect(new Set(NETWORK_ERROR_CODES).size).toBe(NETWORK_ERROR_CODES.length);
  });
});

describe('D-148 W3.1 — preset name disjointness from legacy profile names', () => {
  it('public preset is a distinct shape from any legacy 5-profile entry', () => {
    // The new `public` preset name was deliberately picked NOT to
    // collide with any of the 5 legacy profile names. Verify here so
    // future name changes that would re-introduce ambiguity fail.
    const legacy = ['lan_only', 'public_webhooks', 'public_clients', 'public_webhooks_and_clients', 'maintenance_locked'];
    for (const preset of EXPOSURE_PRESETS) {
      if (preset === 'lan_only') continue; // legacy + new share this name by design
      expect(legacy).not.toContain(preset);
    }
  });
});

describe('D-148 W3.1 — type guards', () => {
  it('ExposurePreset values are all valid PATH map keys', () => {
    for (const preset of EXPOSURE_PRESETS) {
      expect(EXPOSURE_PRESET_PATH_MAP[preset]).toBeDefined();
    }
  });

  it('every PathRole has a default resolution entry', () => {
    for (const role of PATH_ROLES) {
      const entry: PathResolution = DEFAULT_PATH_RESOLUTION[role];
      expect(entry).toBeDefined();
    }
  });

  it('every ExposurePreset shape has entries for all PATH_ROLES', () => {
    for (const preset of EXPOSURE_PRESETS) {
      const shape = EXPOSURE_PRESET_PATH_MAP[preset];
      const keys = Object.keys(shape).sort();
      expect(keys).toEqual([...PATH_ROLES].sort());
    }
  });
});

describe('D-148 W3.1 — matchesPathRole (Codex P2 #2 fold)', () => {
  it('exact base path matches its role', () => {
    expect(matchesPathRole('/health', 'health')).toBe(true);
    expect(matchesPathRole('/ws', 'ws')).toBe(true);
    expect(matchesPathRole('/mcp', 'mcp')).toBe(true);
    expect(matchesPathRole('/webhooks', 'webhooks')).toBe(true);
    expect(matchesPathRole('/reception', 'reception')).toBe(true);
  });

  it('sub-paths under base match the same role', () => {
    // /mcp/catalog is the MCP token-scoped catalog per spec § A.6 —
    // must be claimed by the mcp role (raw exact-match would drop it).
    expect(matchesPathRole('/mcp/catalog', 'mcp')).toBe(true);
    expect(matchesPathRole('/webhooks/slack/conn-abc', 'webhooks')).toBe(true);
    expect(matchesPathRole('/reception/_health', 'reception')).toBe(true);
    expect(matchesPathRole('/reception/intake/abc', 'reception')).toBe(true);
    expect(matchesPathRole('/reception/scheduling/xyz', 'reception')).toBe(true);
  });

  it('adjacent-character paths do NOT match (boundary discipline)', () => {
    // Raw `startsWith` would falsely claim `/mcpevil` / `/webhooksevil`
    // / `/receptionx` / `/healthcheck` for their respective roles —
    // matchesPathRole rejects these via the `/` boundary.
    expect(matchesPathRole('/mcpevil', 'mcp')).toBe(false);
    expect(matchesPathRole('/webhooksevil', 'webhooks')).toBe(false);
    expect(matchesPathRole('/receptionx', 'reception')).toBe(false);
    expect(matchesPathRole('/healthcheck', 'health')).toBe(false);
    expect(matchesPathRole('/wstunnel', 'ws')).toBe(false);
  });

  it('cross-role mismatch returns false', () => {
    expect(matchesPathRole('/mcp', 'webhooks')).toBe(false);
    expect(matchesPathRole('/ws', 'mcp')).toBe(false);
    expect(matchesPathRole('/reception/_health', 'health')).toBe(false);
    expect(matchesPathRole('/webhooks/slack/x', 'reception')).toBe(false);
  });

  it('empty string and root path do not match any role', () => {
    for (const role of PATH_ROLES) {
      expect(matchesPathRole('', role)).toBe(false);
      expect(matchesPathRole('/', role)).toBe(false);
    }
  });

  it('exactly-one role claims every well-formed canonical request path', () => {
    // The dispatcher relies on the role-match being mutually exclusive
    // for canonical sub-paths — i.e. a request can only ever be claimed
    // by one role (the dispatcher fans by first-match-wins semantics,
    // but the test guards against accidental overlap in PATH_FOR_ROLE).
    const samples: Array<{ url: string; role: PathRole }> = [
      { url: '/health', role: 'health' },
      { url: '/ws', role: 'ws' },
      { url: '/mcp', role: 'mcp' },
      { url: '/mcp/catalog', role: 'mcp' },
      { url: '/llm-gateway', role: 'llm_gateway' },
      { url: '/llm-gateway/v1/models', role: 'llm_gateway' },
      { url: '/webhooks/slack/conn-1', role: 'webhooks' },
      { url: '/reception/intake/abc', role: 'reception' },
      { url: '/reception/_health', role: 'reception' },
    ];
    for (const sample of samples) {
      let matchCount = 0;
      let matched: PathRole | null = null;
      for (const role of PATH_ROLES) {
        if (matchesPathRole(sample.url, role)) {
          matchCount++;
          matched = role;
        }
      }
      expect(matchCount).toBe(1);
      expect(matched).toBe(sample.role);
    }
  });
});
