/** D-148 W3.8 — settings: Exposure page renderer + dispatch builders. */

import { describe, expect, it } from 'vitest';
import {
  PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
  WS_LOCKOUT_DISABLE_PHRASE,
  WS_LOCKOUT_DISCONNECT_PHRASE,
  type ExposureState,
  type PathResolution,
  type PathRole,
  type PublicMcpAcknowledgement,
} from '@recued/contracts';
import {
  EXPOSURE_ERROR_COPY,
  EXPOSURE_PATH_COPY,
  EXPOSURE_PRESET_COPY,
  buildExposurePageModel,
  buildPathResolutionDispatch,
  buildPresetDispatch,
  buildPublicMcpDispatch,
  projectCellToggle,
  projectPathWsLockout,
  projectPresetWsLockout,
  projectRequiresPublicMcpAck,
  projectWsLockoutPhrase,
} from '../settings/exposure-surface.js';

const ackOff = (): PublicMcpAcknowledgement => ({ acknowledged: false });
const ackOn = (): PublicMcpAcknowledgement => ({
  acknowledged: true,
  acknowledged_at: 1000,
  acknowledged_by_client_id: 'cli',
  free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
});

const resolution = (
  override: Partial<Record<PathRole, PathResolution>> = {},
): Record<PathRole, PathResolution> => ({
  health: { lan: true, public: false },
  ws: { lan: true, public: false },
  mcp: { lan: true, public: false },
  llm_gateway: { lan: true, public: false },
  webhooks: { lan: false, public: false },
  reception: { lan: false, public: false },
  oauth: { lan: false, public: false },
  ask: { lan: false, public: false },
  webclient: { lan: true, public: false },
  ...override,
});

const buildState = (override: Partial<ExposureState> = {}): ExposureState => ({
  resolution: resolution(),
  derived_preset_label: 'lan_only',
  public_mcp_acknowledgement: ackOff(),
  last_changed_at: 1_000,
  changed_by_client_id: 'cli',
  ...override,
});

describe('D-148 W3.8 — exposure-surface page model', () => {
  it('builds three preset rows in canonical order + flags is_current', () => {
    const model = buildExposurePageModel({ state: buildState(), has_ddns: true });
    expect(model.preset_rows.map((r) => r.preset)).toEqual([
      'lan_only',
      'public',
      'maintenance',
    ]);
    const lan = model.preset_rows.find((r) => r.preset === 'lan_only');
    expect(lan?.is_current).toBe(true);
    const pub = model.preset_rows.find((r) => r.preset === 'public');
    expect(pub?.is_current).toBe(false);
    expect(lan?.label).toBe(EXPOSURE_PRESET_COPY.lan_only.label);
  });

  it('builds nine path rows in canonical order', () => {
    const model = buildExposurePageModel({ state: buildState(), has_ddns: true });
    expect(model.path_rows.map((r) => r.path)).toEqual([
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
    expect(model.path_rows[1].label).toBe(EXPOSURE_PATH_COPY.ws.label);
  });

  it('requires_ddns flag flips on public preset when has_ddns=false', () => {
    const model = buildExposurePageModel({ state: buildState(), has_ddns: false });
    const pub = model.preset_rows.find((r) => r.preset === 'public');
    expect(pub?.requires_ddns).toBe(true);
    const lan = model.preset_rows.find((r) => r.preset === 'lan_only');
    expect(lan?.requires_ddns).toBe(false);
  });

  it('triggers_ws_lockout flag flips on maintenance preset when /ws currently on', () => {
    const model = buildExposurePageModel({ state: buildState(), has_ddns: true });
    const maint = model.preset_rows.find((r) => r.preset === 'maintenance');
    expect(maint?.triggers_ws_lockout).toBe(true);
    const lan = model.preset_rows.find((r) => r.preset === 'lan_only');
    expect(lan?.triggers_ws_lockout).toBe(false);
  });

  it('requires_public_mcp_ack flag set on /mcp row when ack missing', () => {
    const model = buildExposurePageModel({ state: buildState(), has_ddns: true });
    const mcpRow = model.path_rows.find((r) => r.path === 'mcp');
    expect(mcpRow?.requires_public_mcp_ack).toBe(true);
    const wsRow = model.path_rows.find((r) => r.path === 'ws');
    expect(wsRow?.requires_public_mcp_ack).toBe(false);
  });

  it('requires_public_mcp_ack flag clears once ack is valid', () => {
    const model = buildExposurePageModel({
      state: buildState({ public_mcp_acknowledgement: ackOn() }),
      has_ddns: true,
    });
    const mcpRow = model.path_rows.find((r) => r.path === 'mcp');
    expect(mcpRow?.requires_public_mcp_ack).toBe(false);
  });

  it('Codex P2 #1 — malformed ack (acknowledged=true, no canonical phrase) treated as unacknowledged', () => {
    const malformed: PublicMcpAcknowledgement = {
      acknowledged: true,
      // free_text_confirmation deliberately missing
    };
    const model = buildExposurePageModel({
      state: buildState({ public_mcp_acknowledgement: malformed }),
      has_ddns: true,
    });
    const mcpRow = model.path_rows.find((r) => r.path === 'mcp');
    expect(mcpRow?.requires_public_mcp_ack).toBe(true);
  });

  it('triggers_ws_lockout set on /ws row only when at least one bit live', () => {
    const both = buildExposurePageModel({ state: buildState(), has_ddns: true });
    expect(both.path_rows.find((r) => r.path === 'ws')?.triggers_ws_lockout).toBe(true);
    const off = buildExposurePageModel({
      state: buildState({ resolution: resolution({ ws: { lan: false, public: false } }) }),
      has_ddns: true,
    });
    expect(off.path_rows.find((r) => r.path === 'ws')?.triggers_ws_lockout).toBe(false);
  });

  it('Custom drift detection — webhooks toggled into the LAN-only baseline', () => {
    const drifted = buildExposurePageModel({
      state: buildState({
        resolution: resolution({ webhooks: { lan: true, public: false } }),
      }),
      has_ddns: true,
    });
    expect(drifted.derived_preset_label).toBe('custom');
    expect(drifted.preset_rows.every((r) => !r.is_current)).toBe(true);
  });

  it('any_public flips on when at least one path resolves public', () => {
    const lan = buildExposurePageModel({ state: buildState(), has_ddns: true });
    expect(lan.any_public).toBe(false);
    const pub = buildExposurePageModel({
      state: buildState({
        resolution: resolution({ webhooks: { lan: true, public: true } }),
      }),
      has_ddns: true,
    });
    expect(pub.any_public).toBe(true);
  });
});

describe('D-148 W3.8 — error copy', () => {
  it('every NetworkErrorCode has copy assigned', () => {
    const codes = [
      'preset_unknown',
      'preset_unachievable_no_ddns',
      'public_mcp_not_acknowledged',
      'public_mcp_phrase_mismatch',
      'cert_pin_stale',
      'cert_pin_mismatch',
      'rotation_notice_signature_invalid',
      'telegram_port_unsupported',
      'port_in_use',
      'lan_address_unresolved',
      'path_unknown',
      'ws_lockout_unconfirmed',
      'ws_lockout_phrase_mismatch',
      'tls_domain_unknown',
      'tls_san_mismatch',
      'tls_key_pair_mismatch',
      'tls_chain_invalid',
      'tls_cert_expired_at_upload',
    ] as const;
    for (const code of codes) {
      expect(EXPOSURE_ERROR_COPY[code]).toBeTruthy();
    }
  });
});

describe('D-148 W3.8 — dispatch builders', () => {
  it('buildPresetDispatch shapes payload correctly', () => {
    const d = buildPresetDispatch({ preset: 'public', reason: 'manual' });
    expect(d.op).toBe('exposure.apply_preset');
    expect(d.preset).toBe('public');
    expect(d.reason).toBe('manual');
    expect(d.lockout_confirmation_phrase).toBeUndefined();
  });

  it('buildPresetDispatch threads lockout phrase when provided', () => {
    const d = buildPresetDispatch({
      preset: 'maintenance',
      lockout_confirmation_phrase: WS_LOCKOUT_DISCONNECT_PHRASE,
    });
    expect(d.lockout_confirmation_phrase).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
  });

  it('buildPathResolutionDispatch shapes payload correctly', () => {
    const d = buildPathResolutionDispatch({
      path: 'mcp',
      resolution: { lan: true, public: true },
    });
    expect(d.op).toBe('exposure.set_path_resolution');
    expect(d.path).toBe('mcp');
    expect(d.resolution).toEqual({ lan: true, public: true });
  });

  it('buildPathResolutionDispatch clones the resolution (no aliasing)', () => {
    const r = { lan: true, public: false };
    const d = buildPathResolutionDispatch({ path: 'ws', resolution: r });
    r.lan = false;
    expect(d.resolution.lan).toBe(true);
  });

  it('buildPublicMcpDispatch carries phrase only when acknowledging', () => {
    const ack = buildPublicMcpDispatch({
      acknowledge: true,
      free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
    });
    expect(ack.acknowledge).toBe(true);
    expect(ack.free_text_confirmation).toBe(PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
    const revoke = buildPublicMcpDispatch({ acknowledge: false });
    expect(revoke.acknowledge).toBe(false);
    expect(revoke.free_text_confirmation).toBeUndefined();
  });
});

describe('D-148 W3.8 — projection helpers', () => {
  it('projectWsLockoutPhrase returns null when /ws stays on', () => {
    expect(
      projectWsLockoutPhrase({
        next_resolution: { lan: true, public: false },
        active_ws_connections: 0,
      }),
    ).toBeNull();
  });

  it('projectWsLockoutPhrase returns disconnect phrase when active>0', () => {
    expect(
      projectWsLockoutPhrase({
        next_resolution: { lan: false, public: false },
        active_ws_connections: 3,
      }),
    ).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
  });

  it('projectWsLockoutPhrase returns disable phrase when active=0', () => {
    expect(
      projectWsLockoutPhrase({
        next_resolution: { lan: false, public: false },
        active_ws_connections: 0,
      }),
    ).toBe(WS_LOCKOUT_DISABLE_PHRASE);
  });

  it('projectPresetWsLockout returns null on lan_only + public presets', () => {
    expect(
      projectPresetWsLockout({
        preset: 'lan_only',
        acknowledgement: ackOff(),
        current_resolution: resolution(),
        active_ws_connections: 1,
      }),
    ).toBeNull();
    expect(
      projectPresetWsLockout({
        preset: 'public',
        acknowledgement: ackOff(),
        current_resolution: resolution(),
        active_ws_connections: 1,
      }),
    ).toBeNull();
  });

  it('projectPresetWsLockout returns disconnect phrase on maintenance with active clients', () => {
    expect(
      projectPresetWsLockout({
        preset: 'maintenance',
        acknowledgement: ackOff(),
        current_resolution: resolution(),
        active_ws_connections: 2,
      }),
    ).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
  });

  it('projectPresetWsLockout returns null when /ws already off (no transition)', () => {
    expect(
      projectPresetWsLockout({
        preset: 'maintenance',
        acknowledgement: ackOff(),
        current_resolution: resolution({ ws: { lan: false, public: false } }),
        active_ws_connections: 0,
      }),
    ).toBeNull();
  });

  it('projectPathWsLockout only fires on /ws path', () => {
    expect(
      projectPathWsLockout({
        path: 'mcp',
        next_resolution: { lan: false, public: false },
        current_resolution: resolution(),
        active_ws_connections: 1,
      }),
    ).toBeNull();
    expect(
      projectPathWsLockout({
        path: 'ws',
        next_resolution: { lan: false, public: false },
        current_resolution: resolution(),
        active_ws_connections: 1,
      }),
    ).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
  });

  it('projectRequiresPublicMcpAck only fires on /mcp public-promotion', () => {
    expect(
      projectRequiresPublicMcpAck({
        path: 'webhooks',
        next_resolution: { lan: true, public: true },
        current_resolution: resolution(),
        acknowledgement: ackOff(),
      }),
    ).toBe(false);
    expect(
      projectRequiresPublicMcpAck({
        path: 'mcp',
        next_resolution: { lan: true, public: true },
        current_resolution: resolution(),
        acknowledgement: ackOff(),
      }),
    ).toBe(true);
    expect(
      projectRequiresPublicMcpAck({
        path: 'mcp',
        next_resolution: { lan: true, public: true },
        current_resolution: resolution(),
        acknowledgement: ackOn(),
      }),
    ).toBe(false);
  });

  it('Codex P2 #1 — projectRequiresPublicMcpAck treats malformed ack as unacknowledged', () => {
    const malformed: PublicMcpAcknowledgement = {
      acknowledged: true,
      free_text_confirmation: 'wrong phrase',
    };
    expect(
      projectRequiresPublicMcpAck({
        path: 'mcp',
        next_resolution: { lan: true, public: true },
        current_resolution: resolution(),
        acknowledgement: malformed,
      }),
    ).toBe(true);
  });

  it('projectCellToggle flips the targeted cell, leaves others alone', () => {
    const next = projectCellToggle({
      current_resolution: resolution(),
      path: 'webhooks',
      cell: 'public',
    });
    expect(next.webhooks).toEqual({ lan: false, public: true });
    expect(next.ws).toEqual({ lan: true, public: false });
  });
});
