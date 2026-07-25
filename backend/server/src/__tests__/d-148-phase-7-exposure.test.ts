/** D-148 W3.5 — Per-path Exposure state machine acceptance.
 *
 *  Replaces the per-port acceptance file. Covers spec § A.7 +
 *  § A.6.6 + § A.7.2 + § A.7.4:
 *   - applyPreset('lan_only' / 'public' / 'maintenance') snaps the
 *     toggle grid; derived_preset_label recomputed; broadcast carries
 *     resolution + label
 *   - setPathResolution single-path mutation + DDNS gate + custom
 *     label transition
 *   - /mcp.public acknowledgement gate (free-text phrase required;
 *     demotion free)
 *   - /ws lockout phrase gate (active>0 = disconnect; active=0 = disable;
 *     missing/wrong phrase = ws_lockout_unconfirmed / _phrase_mismatch)
 *   - listener-bind failure surfaces; audit row precedes listener apply
 */

import { describe, it, expect } from 'vitest';
import {
  EXPOSURE_PRESETS,
  PATH_ROLES,
  PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
  WS_LOCKOUT_DISCONNECT_PHRASE,
  WS_LOCKOUT_DISABLE_PHRASE,
  applyPreset,
  type ExposureChangedEvent,
  type ExposureState,
  type PathResolution,
  type PathRole,
} from '@recued/contracts';
import {
  createExposureStateMachine,
  createInMemoryExposureStore,
  DEFAULT_EXPOSURE_STATE,
  type PathListenerCoordinator,
  type ExposureSideEffects,
  type DdnsAvailability,
  type ActiveWsConnections,
} from '../exposure/index.js';

interface AuditCall {
  action:
    | 'exposure_path_resolution_change'
    | 'exposure_preset_apply'
    | 'public_mcp_acknowledged'
    | 'public_mcp_revoked';
  resolution: Record<PathRole, PathResolution>;
  derived_preset_label: ExposureState['derived_preset_label'];
  public_mcp_acknowledgement: ExposureState['public_mcp_acknowledgement'];
  changed_by_client_id: string;
  reason?: string;
  free_text_confirmation?: string;
  path?: PathRole;
  next_resolution?: PathResolution;
  active_ws_connections?: number;
}

const makeListener = (): {
  coord: PathListenerCoordinator;
  applied: Array<{ resolution: Record<PathRole, PathResolution> }>;
  bindFails: { lan?: boolean; public?: boolean };
} => {
  const applied: Array<{ resolution: Record<PathRole, PathResolution> }> = [];
  const bindFails: { lan?: boolean; public?: boolean } = {};
  return {
    bindFails,
    applied,
    coord: {
      apply: async ({ resolution, bind_addresses }) => {
        applied.push({ resolution });
        const lanWanted = Object.values(resolution).some((r) => r.lan);
        const publicWanted = Object.values(resolution).some((r) => r.public);
        return {
          lan: {
            listening: lanWanted && !bindFails.lan,
            bind_address: lanWanted ? bind_addresses.lan : null,
            ...(lanWanted && bindFails.lan ? { failure: 'port_in_use' } : {}),
          },
          public: {
            listening: publicWanted && !bindFails.public,
            bind_address: publicWanted ? bind_addresses.public : null,
            ...(publicWanted && bindFails.public ? { failure: 'port_in_use' } : {}),
          },
        };
      },
    },
  };
};

const makeEffects = (): {
  effects: ExposureSideEffects;
  audits: AuditCall[];
  broadcasts: ExposureChangedEvent[];
} => {
  const audits: AuditCall[] = [];
  const broadcasts: ExposureChangedEvent[] = [];
  return {
    audits,
    broadcasts,
    effects: {
      recordAudit: async (entry) => {
        audits.push({ ...entry });
      },
      broadcast: async (event) => {
        broadcasts.push({ ...event });
      },
    },
  };
};

const makeDdns = (configured: boolean): DdnsAvailability => ({
  isConfigured: async () => configured,
});

const makeActive = (count: number): ActiveWsConnections => ({
  count: () => count,
});

const makeMachine = (
  args: {
    ddns?: boolean;
    clock?: () => number;
    initial?: ExposureState;
    active_ws?: number;
  } = {},
) => {
  const { coord, applied, bindFails } = makeListener();
  const { effects, audits, broadcasts } = makeEffects();
  const store = createInMemoryExposureStore(args.initial);
  const machine = createExposureStateMachine({
    store,
    listener: coord,
    effects,
    ddns: makeDdns(args.ddns ?? true),
    bind_addresses: { lan: '192.168.1.42', public: '0.0.0.0' },
    activeWsConnections: makeActive(args.active_ws ?? 0),
    clock: args.clock,
  });
  return { machine, applied, bindFails, audits, broadcasts, store };
};

describe('D-148 W3.5 — applyPreset', () => {
  it('lan_only preset snaps to baseline (LAN-only on health/ws/mcp)', async () => {
    const { machine, audits, broadcasts, applied } = makeMachine({
      initial: { ...DEFAULT_EXPOSURE_STATE },
    });
    const r = await machine.applyPreset({
      preset: 'lan_only',
      changed_by_client_id: 'admin-1',
      reason: 'baseline',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.state.derived_preset_label).toBe('lan_only');
    expect(r.state.resolution.ws).toEqual({ lan: true, public: false });
    expect(r.state.resolution.mcp).toEqual({ lan: true, public: false });
    expect(r.state.resolution.webhooks).toEqual({ lan: false, public: false });
    expect(r.state.resolution.reception).toEqual({ lan: false, public: false });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('exposure_preset_apply');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.derived_preset_label).toBe('lan_only');
    expect(applied).toHaveLength(1);
  });

  it('public preset opens webhooks + reception lan+public; /mcp.public stays false without ack', async () => {
    const { machine } = makeMachine();
    const r = await machine.applyPreset({
      preset: 'public',
      changed_by_client_id: 'admin-1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.state.resolution.webhooks).toEqual({ lan: true, public: true });
    expect(r.state.resolution.reception).toEqual({ lan: true, public: true });
    // /mcp.public must stay false without ack.
    expect(r.state.resolution.mcp.public).toBe(false);
    // Without ack, the public preset's shape is mcp.public=false so
    // derived_preset_label correctly reads 'public'.
    expect(r.state.derived_preset_label).toBe('public');
  });

  it('maintenance preset closes every path (with lockout phrase, since /ws goes off)', async () => {
    const { machine } = makeMachine({ active_ws: 0 });
    const r = await machine.applyPreset({
      preset: 'maintenance',
      lockout_confirmation_phrase: WS_LOCKOUT_DISABLE_PHRASE,
      changed_by_client_id: 'admin-1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    for (const role of PATH_ROLES) {
      expect(r.state.resolution[role]).toEqual({ lan: false, public: false });
    }
    expect(r.state.derived_preset_label).toBe('maintenance');
  });

  it('Codex W3.5 P1 fold: maintenance preset on /ws-enabled state demands lockout phrase', async () => {
    const { machine, audits } = makeMachine({ active_ws: 2 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    audits.length = 0;
    // Without phrase → reject with ws_lockout_unconfirmed.
    const r1 = await machine.applyPreset({
      preset: 'maintenance',
      changed_by_client_id: 'admin',
    });
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error('unreachable');
    expect(r1.error).toBe('ws_lockout_unconfirmed');
    expect(r1.ws_lockout_required_phrase).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
    expect(r1.ws_lockout_active_clients).toBe(2);
    expect(audits).toHaveLength(0);
  });

  it('Codex W3.5 P1 fold: maintenance preset with correct phrase succeeds + audit carries phrase', async () => {
    const { machine, audits } = makeMachine({ active_ws: 3 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    audits.length = 0;
    const r = await machine.applyPreset({
      preset: 'maintenance',
      lockout_confirmation_phrase: WS_LOCKOUT_DISCONNECT_PHRASE,
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    for (const role of PATH_ROLES) {
      expect(r.state.resolution[role]).toEqual({ lan: false, public: false });
    }
    const presetAudit = audits.find((a) => a.action === 'exposure_preset_apply');
    expect(presetAudit).toBeDefined();
    expect(presetAudit!.free_text_confirmation).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
    expect(presetAudit!.active_ws_connections).toBe(3);
  });

  it('Codex W3.5 P1 fold: maintenance preset with wrong phrase rejects (phrase_mismatch)', async () => {
    const { machine } = makeMachine({ active_ws: 1 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    const r = await machine.applyPreset({
      preset: 'maintenance',
      lockout_confirmation_phrase: 'wrong phrase',
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('ws_lockout_phrase_mismatch');
  });

  it('Codex W3.5 P1 fold: lan_only → public preset keeps /ws enabled, no lockout gate', async () => {
    const { machine, audits } = makeMachine({ active_ws: 5 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    audits.length = 0;
    const r = await machine.applyPreset({
      preset: 'public',
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.state.resolution.ws.lan || r.state.resolution.ws.public).toBe(true);
  });

  it('Codex W3.5 P1 fold: maintenance preset on already-maintenance state skips lockout (no transition)', async () => {
    const { machine, audits } = makeMachine({ active_ws: 0 });
    // First trip into maintenance with the appropriate phrase.
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    await machine.applyPreset({
      preset: 'maintenance',
      lockout_confirmation_phrase: WS_LOCKOUT_DISABLE_PHRASE,
      changed_by_client_id: 'admin',
    });
    audits.length = 0;
    // Re-applying maintenance is a no-op for /ws (already fully off);
    // no phrase required.
    const r = await machine.applyPreset({
      preset: 'maintenance',
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
  });

  it('refuses public preset when DDNS not configured', async () => {
    const { machine, audits } = makeMachine({ ddns: false });
    const r = await machine.applyPreset({
      preset: 'public',
      changed_by_client_id: 'admin-1',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('preset_unachievable_no_ddns');
    expect(audits).toHaveLength(0);
  });

  it('rejects unknown preset name', async () => {
    const { machine } = makeMachine();
    const r = await machine.applyPreset({
      preset: 'bogus' as never,
      changed_by_client_id: 'admin-1',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('preset_unknown');
  });
});

describe('D-148 W3.5 — setPathResolution', () => {
  it('mutating /webhooks lan+public on lan_only base flips to custom label', async () => {
    const { machine } = makeMachine();
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    const r = await machine.setPathResolution({
      path: 'webhooks',
      resolution: { lan: true, public: true },
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.state.resolution.webhooks).toEqual({ lan: true, public: true });
    expect(r.state.derived_preset_label).toBe('custom');
  });

  it('rejects unknown path', async () => {
    const { machine } = makeMachine();
    const r = await machine.setPathResolution({
      path: 'bogus' as never,
      resolution: { lan: true, public: false },
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('path_unknown');
  });

  it('rejects mcp.public promotion without ack', async () => {
    const { machine } = makeMachine();
    const r = await machine.setPathResolution({
      path: 'mcp',
      resolution: { lan: true, public: true },
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('public_mcp_not_acknowledged');
  });

  it('allows mcp.public demotion without ack', async () => {
    const { machine } = makeMachine();
    // Set ack first
    await machine.setPublicMcpAcknowledgement({
      acknowledge: true,
      free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
      changed_by_client_id: 'admin',
    });
    await machine.setPathResolution({
      path: 'mcp',
      resolution: { lan: true, public: true },
      changed_by_client_id: 'admin',
    });
    // Now demote
    const r = await machine.setPathResolution({
      path: 'mcp',
      resolution: { lan: true, public: false },
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.state.resolution.mcp.public).toBe(false);
  });

  it('DDNS gate fires for any public resolution change', async () => {
    const { machine } = makeMachine({ ddns: false });
    const r = await machine.setPathResolution({
      path: 'webhooks',
      resolution: { lan: false, public: true },
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('preset_unachievable_no_ddns');
  });
});

describe('D-148 W3.5 — /ws lockout phrase gate (§ A.6.6)', () => {
  it('active=0 + no phrase → ws_lockout_unconfirmed with disable phrase', async () => {
    const { machine } = makeMachine({ active_ws: 0 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    const r = await machine.setPathResolution({
      path: 'ws',
      resolution: { lan: false, public: false },
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('ws_lockout_unconfirmed');
    expect(r.ws_lockout_required_phrase).toBe(WS_LOCKOUT_DISABLE_PHRASE);
    expect(r.ws_lockout_active_clients).toBe(0);
  });

  it('active>0 + no phrase → ws_lockout_unconfirmed with disconnect phrase', async () => {
    const { machine } = makeMachine({ active_ws: 3 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    const r = await machine.setPathResolution({
      path: 'ws',
      resolution: { lan: false, public: false },
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('ws_lockout_unconfirmed');
    expect(r.ws_lockout_required_phrase).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
    expect(r.ws_lockout_active_clients).toBe(3);
  });

  it('wrong phrase → ws_lockout_phrase_mismatch', async () => {
    const { machine } = makeMachine({ active_ws: 1 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    const r = await machine.setPathResolution({
      path: 'ws',
      resolution: { lan: false, public: false },
      lockout_confirmation_phrase: 'oops',
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('ws_lockout_phrase_mismatch');
  });

  it('correct phrase + active>0 → success; audit row carries phrase + count', async () => {
    const { machine, audits } = makeMachine({ active_ws: 2 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    const r = await machine.setPathResolution({
      path: 'ws',
      resolution: { lan: false, public: false },
      lockout_confirmation_phrase: WS_LOCKOUT_DISCONNECT_PHRASE,
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.state.resolution.ws).toEqual({ lan: false, public: false });
    const wsAudit = audits.find((a) => a.action === 'exposure_path_resolution_change');
    expect(wsAudit).toBeDefined();
    expect(wsAudit!.free_text_confirmation).toBe(WS_LOCKOUT_DISCONNECT_PHRASE);
    expect(wsAudit!.active_ws_connections).toBe(2);
  });

  it('not triggered when /ws keeps at least one bit true', async () => {
    const { machine } = makeMachine({ active_ws: 5 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    // Going from {lan:true, public:false} → {lan:false, public:true}
    // doesn't trigger (still reachable).
    const r = await machine.setPathResolution({
      path: 'ws',
      resolution: { lan: false, public: true },
      changed_by_client_id: 'admin',
    });
    // Will fail on DDNS, not lockout.
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.state.resolution.ws).toEqual({ lan: false, public: true });
  });
});

describe('D-148 W3.5 — public-MCP acknowledgement gate', () => {
  it('toggle on without phrase fails; with phrase succeeds; toggle off needs no phrase', async () => {
    const { machine, audits, broadcasts } = makeMachine();
    await machine.applyPreset({ preset: 'public', changed_by_client_id: 'admin' });
    // No phrase → reject.
    const r1 = await machine.setPublicMcpAcknowledgement({
      acknowledge: true,
      changed_by_client_id: 'admin',
    });
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error('unreachable');
    expect(r1.error).toBe('public_mcp_not_acknowledged');
    // Wrong phrase → reject.
    const r2 = await machine.setPublicMcpAcknowledgement({
      acknowledge: true,
      free_text_confirmation: 'enable PUBLIC mcp',
      changed_by_client_id: 'admin',
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('unreachable');
    expect(r2.error).toBe('public_mcp_phrase_mismatch');
    // Correct phrase → ack flips, no mcp.public promotion until user toggles it
    const r3 = await machine.setPublicMcpAcknowledgement({
      acknowledge: true,
      free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
      changed_by_client_id: 'admin',
    });
    expect(r3.ok).toBe(true);
    if (!r3.ok) throw new Error('unreachable');
    expect(r3.state.public_mcp_acknowledgement.acknowledged).toBe(true);
    const ackAudit = audits.find((a) => a.action === 'public_mcp_acknowledged');
    expect(ackAudit).toBeDefined();
    expect(ackAudit!.free_text_confirmation).toBe(PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
    // Toggle off — no phrase needed. Also forces mcp.public to false.
    const r4 = await machine.setPublicMcpAcknowledgement({
      acknowledge: false,
      changed_by_client_id: 'admin',
    });
    expect(r4.ok).toBe(true);
    if (!r4.ok) throw new Error('unreachable');
    expect(r4.state.public_mcp_acknowledgement.acknowledged).toBe(false);
    expect(r4.state.resolution.mcp.public).toBe(false);
    expect(audits.some((a) => a.action === 'public_mcp_revoked')).toBe(true);
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
  });

  it('public-MCP fuzz: every preset shape × ack=false → mcp.public never true', () => {
    for (const preset of EXPOSURE_PRESETS) {
      const resolution = applyPreset(preset, { acknowledged: false });
      expect(resolution.mcp.public).toBe(false);
    }
  });

  it('malformed ack record (true without phrase) refused at well-formedness check', async () => {
    const { machine } = makeMachine();
    const r = await machine.setPublicMcpAcknowledgement({
      acknowledge: true,
      free_text_confirmation: undefined,
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('public_mcp_not_acknowledged');
  });
});

describe('D-148 W3.5 — listener bind failure surfacing + reapply', () => {
  it('listener bind failure does NOT abort the transition (audit + broadcast record intent)', async () => {
    const { machine, applied, bindFails, audits, broadcasts } = makeMachine();
    bindFails.lan = true;
    const r = await machine.applyPreset({
      preset: 'lan_only',
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(applied).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  it('reapply uses persisted state without re-emitting audit', async () => {
    const initial: ExposureState = {
      ...DEFAULT_EXPOSURE_STATE,
      derived_preset_label: 'lan_only',
      last_changed_at: 1_700_000_000_000,
      changed_by_client_id: 'admin-1',
    };
    const { machine, audits, broadcasts, applied } = makeMachine({ initial });
    const out = await machine.reapply();
    expect(out.derived_preset_label).toBe('lan_only');
    expect(applied).toHaveLength(1);
    expect(audits).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });
});

describe('D-148 W3.5 — broadcast carries new shape', () => {
  it('broadcast event mirrors resolution + derived_preset_label + ack', async () => {
    const { machine, broadcasts } = makeMachine();
    await machine.applyPreset({ preset: 'public', changed_by_client_id: 'admin' });
    const last = broadcasts[broadcasts.length - 1]!;
    expect(last.type).toBe('exposure_changed');
    expect(last.derived_preset_label).toBe('public');
    expect(last.resolution.webhooks).toEqual({ lan: true, public: true });
    expect(last.public_mcp_acknowledgement.acknowledged).toBe(false);
  });
});
