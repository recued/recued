/** D-148 W3.5 — settings: per-path exposure switcher model. */

import { describe, expect, it } from 'vitest';
import {
  WS_LOCKOUT_DISABLE_PHRASE,
  type ExposureState,
  type PublicMcpAcknowledgement,
} from '@recued/contracts';
import {
  buildExposureSwitcherModel,
  isPresetTransitionAllowed,
  isPathResolutionTransitionAllowed,
} from '../settings/exposure-profile.js';

const baseAck = (): PublicMcpAcknowledgement => ({ acknowledged: false });

const buildState = (
  derived_preset_label: ExposureState['derived_preset_label'],
): ExposureState => {
  const resolution = derived_preset_label === 'lan_only'
    ? {
        health: { lan: true, public: false },
        ws: { lan: true, public: false },
        mcp: { lan: true, public: false },
        llm_gateway: { lan: true, public: false },
        webhooks: { lan: false, public: false },
        reception: { lan: false, public: false },
        oauth: { lan: false, public: false },
        ask: { lan: false, public: false },
        webclient: { lan: true, public: false },
      }
    : derived_preset_label === 'public'
    ? {
        health: { lan: true, public: true },
        ws: { lan: true, public: true },
        mcp: { lan: true, public: false },
        llm_gateway: { lan: true, public: true },
        webhooks: { lan: true, public: true },
        reception: { lan: true, public: true },
        // Must match the real `public` preset shape (D-165 slice 3 serves
        // oauth in the public preset) so the model's `deriveLabel`-based
        // `is_current` resolves to 'public'.
        oauth: { lan: true, public: true },
        ask: { lan: true, public: true },
        webclient: { lan: true, public: false },
      }
    : derived_preset_label === 'maintenance'
    ? {
        health: { lan: false, public: false },
        ws: { lan: false, public: false },
        mcp: { lan: false, public: false },
        llm_gateway: { lan: false, public: false },
        webhooks: { lan: false, public: false },
        reception: { lan: false, public: false },
        oauth: { lan: false, public: false },
        ask: { lan: false, public: false },
        webclient: { lan: false, public: false },
      }
    : {
        // custom
        health: { lan: true, public: false },
        ws: { lan: true, public: true },
        mcp: { lan: true, public: false },
        llm_gateway: { lan: true, public: false },
        webhooks: { lan: false, public: false },
        reception: { lan: false, public: false },
        oauth: { lan: false, public: false },
        ask: { lan: false, public: false },
        webclient: { lan: true, public: false },
      };
  return {
    resolution,
    derived_preset_label,
    public_mcp_acknowledgement: baseAck(),
    last_changed_at: 1_000,
    changed_by_client_id: 'cli',
  };
};

describe('D-148 W3.5 — settings.exposure', () => {
  it('builds switcher model + flags any_public', () => {
    const model = buildExposureSwitcherModel({
      state: buildState('public'),
      has_ddns: true,
    });
    expect(model.derived_preset_label).toBe('public');
    expect(model.resolution.ws).toEqual({ lan: true, public: true });
    expect(model.resolution.mcp).toEqual({ lan: true, public: false });
    expect(model.any_public).toBe(true);
    expect(model.options.length).toBe(3);
    const cur = model.options.find((o) => o.is_current);
    expect(cur?.preset).toBe('public');
  });

  it('flags requires_ddns when missing', () => {
    const model = buildExposureSwitcherModel({
      state: buildState('lan_only'),
      has_ddns: false,
    });
    const pub = model.options.find((o) => o.preset === 'public');
    expect(pub?.requires_ddns).toBe(true);
    const lan = model.options.find((o) => o.preset === 'lan_only');
    expect(lan?.requires_ddns).toBe(false);
  });

  it('isPresetTransitionAllowed: preset_unknown', () => {
    const r = isPresetTransitionAllowed({
      preset: 'not-a-preset' as never,
      has_ddns: true,
      acknowledgement: baseAck(),
    });
    expect(r).toEqual({ ok: false, error: 'preset_unknown' });
  });

  it('isPresetTransitionAllowed: preset_unachievable_no_ddns', () => {
    const r = isPresetTransitionAllowed({
      preset: 'public',
      has_ddns: false,
      acknowledgement: baseAck(),
    });
    expect(r).toEqual({ ok: false, error: 'preset_unachievable_no_ddns' });
  });

  it('isPresetTransitionAllowed: ok with projected resolution', () => {
    const r = isPresetTransitionAllowed({
      preset: 'public',
      has_ddns: true,
      acknowledgement: baseAck(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolution.webhooks).toEqual({ lan: true, public: true });
      expect(r.resolution.mcp).toEqual({ lan: true, public: false });
    }
  });

  it('isPathResolutionTransitionAllowed: ws lockout requires phrase', () => {
    const r = isPathResolutionTransitionAllowed({
      current: buildState('lan_only'),
      path: 'ws',
      resolution: { lan: false, public: false },
      has_ddns: true,
      has_ws_lockout_confirmation: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('ws_lockout_unconfirmed');
    }
  });

  it('isPathResolutionTransitionAllowed: ws lockout passes with confirmation flag', () => {
    const r = isPathResolutionTransitionAllowed({
      current: buildState('lan_only'),
      path: 'ws',
      resolution: { lan: false, public: false },
      has_ddns: true,
      has_ws_lockout_confirmation: true,
    });
    expect(r.ok).toBe(true);
  });

  it('isPathResolutionTransitionAllowed: mcp.public requires ack', () => {
    const r = isPathResolutionTransitionAllowed({
      current: buildState('lan_only'),
      path: 'mcp',
      resolution: { lan: true, public: true },
      has_ddns: true,
      has_ws_lockout_confirmation: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('public_mcp_not_acknowledged');
  });

  it('WS lockout disable phrase is the canonical literal', () => {
    expect(WS_LOCKOUT_DISABLE_PHRASE).toBe('disable ws');
  });
});
