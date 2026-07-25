/** D-148 P1 — network substrate (Amendment 2026-05-11 retires 5-profile/PortRole).
 *
 *  Encodes invariant I-13 (MCP is not bundled with public WS) under the
 *  path-routing model: the `public` preset shape does NOT include
 *  `/mcp.public = true` unless the acknowledgement gate is satisfied
 *  (`applyPreset` threads the ack). Public-MCP gate semantics +
 *  Telegram-supported ports stay; the per-port 5-profile mapping
 *  retires with the per-path substrate as the source of truth.
 */

import { describe, it, expect } from 'vitest';
import {
  TELEGRAM_SUPPORTED_PORTS,
  isTelegramSupportedPort,
  isAcknowledgementWellFormed,
  PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
  isValidPublicMcpAcknowledgementPhrase,
  NETWORK_ERROR_CODES,
  PATH_ROLES,
  EXPOSURE_PRESETS,
  EXPOSURE_PRESET_PATH_MAP,
  applyPreset,
  type PublicMcpAcknowledgement,
} from '../network.js';

describe('D-148 P1 — Telegram-supported ports (carried forward)', () => {
  it('TELEGRAM_SUPPORTED_PORTS is the closed list 443/80/88/8443', () => {
    expect([...TELEGRAM_SUPPORTED_PORTS].sort((a, b) => a - b)).toEqual([80, 88, 443, 8443]);
  });

  it('isTelegramSupportedPort accepts the closed list', () => {
    expect(isTelegramSupportedPort(443)).toBe(true);
    expect(isTelegramSupportedPort(80)).toBe(true);
    expect(isTelegramSupportedPort(88)).toBe(true);
    expect(isTelegramSupportedPort(8443)).toBe(true);
  });

  it('isTelegramSupportedPort rejects out-of-list ports', () => {
    expect(isTelegramSupportedPort(8444)).toBe(false);
    expect(isTelegramSupportedPort(8446)).toBe(false);
    expect(isTelegramSupportedPort(0)).toBe(false);
  });
});

describe('D-148 P1 — isAcknowledgementWellFormed (Codex P1 #1 fold; carried forward)', () => {
  it('accepts acknowledged: false regardless of phrase', () => {
    expect(isAcknowledgementWellFormed({ acknowledged: false })).toBe(true);
    expect(isAcknowledgementWellFormed({
      acknowledged: false,
      free_text_confirmation: 'irrelevant',
    })).toBe(true);
  });

  it('accepts acknowledged: true with the correct phrase', () => {
    expect(isAcknowledgementWellFormed({
      acknowledged: true,
      free_text_confirmation: 'enable public MCP',
    })).toBe(true);
  });

  it('rejects acknowledged: true with missing phrase (bare boolean cannot flip)', () => {
    expect(isAcknowledgementWellFormed({ acknowledged: true })).toBe(false);
  });

  it('rejects acknowledged: true with wrong phrase', () => {
    expect(isAcknowledgementWellFormed({
      acknowledged: true,
      free_text_confirmation: 'enable mcp',
    })).toBe(false);
    expect(isAcknowledgementWellFormed({
      acknowledged: true,
      free_text_confirmation: 'Enable Public MCP',
    })).toBe(false);
    expect(isAcknowledgementWellFormed({
      acknowledged: true,
      free_text_confirmation: 'yes',
    })).toBe(false);
  });
});

describe('D-148 P1 — public MCP acknowledgement phrase (carried forward)', () => {
  it('PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE is the canonical literal', () => {
    expect(PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE).toBe('enable public MCP');
  });

  it('isValidPublicMcpAcknowledgementPhrase accepts exact phrase', () => {
    expect(isValidPublicMcpAcknowledgementPhrase('enable public MCP')).toBe(true);
    expect(isValidPublicMcpAcknowledgementPhrase('  enable public MCP  ')).toBe(true);
  });

  it('isValidPublicMcpAcknowledgementPhrase rejects case + word changes', () => {
    expect(isValidPublicMcpAcknowledgementPhrase('Enable Public MCP')).toBe(false);
    expect(isValidPublicMcpAcknowledgementPhrase('enable PUBLIC mcp')).toBe(false);
    expect(isValidPublicMcpAcknowledgementPhrase('enable public mcp')).toBe(false);
    expect(isValidPublicMcpAcknowledgementPhrase('enable mcp')).toBe(false);
    expect(isValidPublicMcpAcknowledgementPhrase('')).toBe(false);
    expect(isValidPublicMcpAcknowledgementPhrase('y')).toBe(false);
  });
});

describe('D-148 P1 — path-routing substrate replaces 5-profile (W3.5)', () => {
  it('PATH_ROLES enumerates exactly 9 roles: health/ws/mcp/llm_gateway/webhooks/reception/oauth/ask/webclient', () => {
    expect(PATH_ROLES.length).toBe(9);
    expect(new Set(PATH_ROLES).size).toBe(9);
    expect([...PATH_ROLES].sort()).toEqual(['ask', 'health', 'llm_gateway', 'mcp', 'oauth', 'reception', 'webclient', 'webhooks', 'ws']);
  });

  it('EXPOSURE_PRESETS is the closed list of 3: lan_only/public/maintenance', () => {
    expect(EXPOSURE_PRESETS.length).toBe(3);
    expect([...EXPOSURE_PRESETS]).toEqual(['lan_only', 'public', 'maintenance']);
  });

  it('I-13 under path routing: every preset baseline has mcp.public=false; only ack-threaded applyPreset can flip it', () => {
    for (const preset of EXPOSURE_PRESETS) {
      expect(EXPOSURE_PRESET_PATH_MAP[preset].mcp.public).toBe(false);
    }
    // Even with ack off, applyPreset never flips mcp.public.
    for (const preset of EXPOSURE_PRESETS) {
      const r = applyPreset(preset, { acknowledged: false });
      expect(r.mcp.public).toBe(false);
    }
  });

  it('applyPreset("public") with valid ack does flip mcp.public=true (sole path)', () => {
    const ack: PublicMcpAcknowledgement = {
      acknowledged: true,
      free_text_confirmation: 'enable public MCP',
    };
    const r = applyPreset('public', ack);
    expect(r.mcp.public).toBe(true);
    expect(r.mcp.lan).toBe(true);
  });

  it('applyPreset("public") with malformed ack (true without phrase) keeps mcp.public=false (defense-in-depth)', () => {
    const r = applyPreset('public', { acknowledged: true });
    expect(r.mcp.public).toBe(false);
  });
});

describe('D-148 P1 — NETWORK_ERROR_CODES', () => {
  it('contains required codes per spec (post-amendment)', () => {
    expect(NETWORK_ERROR_CODES).toContain('telegram_port_unsupported');
    expect(NETWORK_ERROR_CODES).toContain('cert_pin_stale');
    expect(NETWORK_ERROR_CODES).toContain('public_mcp_phrase_mismatch');
    expect(NETWORK_ERROR_CODES).toContain('rotation_notice_signature_invalid');
    // W3.5 renames: preset_unknown / preset_unachievable_no_ddns
    expect(NETWORK_ERROR_CODES).toContain('preset_unknown');
    expect(NETWORK_ERROR_CODES).toContain('preset_unachievable_no_ddns');
    expect(NETWORK_ERROR_CODES).toContain('ws_lockout_unconfirmed');
    expect(NETWORK_ERROR_CODES).toContain('ws_lockout_phrase_mismatch');
    expect(NETWORK_ERROR_CODES).toContain('path_unknown');
  });

  it('legacy profile_* codes retired', () => {
    expect(NETWORK_ERROR_CODES).not.toContain('profile_unknown' as never);
    expect(NETWORK_ERROR_CODES).not.toContain('profile_unachievable_no_ddns' as never);
  });

  it('codes are unique', () => {
    expect(new Set(NETWORK_ERROR_CODES).size).toBe(NETWORK_ERROR_CODES.length);
  });
});
