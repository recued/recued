/** D-148 W3.5 — settings: per-path exposure switcher model. */

import { describe, expect, it } from 'vitest';
import {
  PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
  WS_LOCKOUT_DISABLE_PHRASE,
  type ExposureState,
  type PathRole,
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

  it('⛔ mcp.public is ALLOWED once the acknowledgement is on', () => {
    // ⚠ THE COMPLEMENT THAT MAKES THE CASE ABOVE MEAN ANYTHING. That test
    // asserts the refusal fires, and mutation shows it cannot tell WHICH
    // condition produced it: deleting the acknowledgement check entirely leaves
    // the other two (`path === 'mcp'`, `resolution.public`), which still refuse
    // for that fixture. Only an acknowledged state distinguishes the gate from
    // a blanket "mcp may never go public".
    //
    // ⚠ THE FIXTURE CARRIES THE CANONICAL PHRASE, AND MUST. It used to be
    // `{ acknowledged: true }` with no phrase — which is a MALFORMED record,
    // not an acknowledged one — so this test was pinning the bug fixed on
    // 2026-09-17: the gate checked only the boolean, and a record the server
    // refuses passed the client pre-flight. The complement below covers the
    // malformed case that fixture actually described.
    const base = buildState('lan_only');
    const acknowledged: typeof base = {
      ...base,
      public_mcp_acknowledgement: {
        acknowledged: true,
        free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
      },
    };
    const r = isPathResolutionTransitionAllowed({
      current: acknowledged,
      path: 'mcp',
      resolution: { lan: true, public: true },
      has_ddns: true,
      has_ws_lockout_confirmation: false,
    });
    expect(r.ok, 'an acknowledged owner is still refused — the gate is a blanket ban').toBe(true);
  });

  it('⛔⛔ a MALFORMED acknowledgement does not open /mcp.public', () => {
    // ⛔ THE DEFECT THIS SUITE USED TO PIN. `acknowledged: true` with a
    // missing or non-canonical phrase is malformed; `isAcknowledgementWellFormed`
    // says so and the SERVER refuses it. This pre-flight checked only the
    // boolean, so it answered `ok` and the UI fired the rpc — the owner got a
    // round-trip error where they should have got the acknowledgement modal.
    //
    // ⚠ The sibling pre-flight (`projectRequiresPublicMcpAck` in
    // exposure-surface.ts) took the Codex W3.8 P2 #1 fold for exactly this and
    // has its own test; this helper was missed because the two are separate
    // helpers for one gate. Both now call the contracts predicate.
    const base = buildState('lan_only');
    for (const ack of [
      { acknowledged: true },
      { acknowledged: true, free_text_confirmation: '' },
      { acknowledged: true, free_text_confirmation: 'enable public mcp please' },
      { acknowledged: true, free_text_confirmation: 'ENABLE PUBLIC MCP' },
    ] as const) {
      const r = isPathResolutionTransitionAllowed({
        current: { ...base, public_mcp_acknowledgement: ack },
        path: 'mcp',
        resolution: { lan: true, public: true },
        has_ddns: true,
        has_ws_lockout_confirmation: false,
      });
      expect(
        r.ok,
        `a malformed ack ${JSON.stringify(ack)} was accepted as consent to go public`,
      ).toBe(false);
      if (!r.ok) expect(r.error).toBe('public_mcp_not_acknowledged');
    }
  });

  it('⚠ re-asserting an ALREADY-public mcp needs no fresh acknowledgement', () => {
    // ⛔ The gate is on the TRANSITION, not on the state. `!current.resolution
    // .mcp.public` is what makes that true, and deleting it was invisible —
    // every existing fixture starts from mcp private. Without it a no-op write
    // (any unrelated grid edit that resends the row) would demand the modal
    // again, and a reader who already answered it is being asked to confirm
    // something they did not change.
    const base = buildState('lan_only');
    const alreadyPublic: typeof base = {
      ...base,
      resolution: { ...base.resolution, mcp: { lan: true, public: true } },
    };
    const r = isPathResolutionTransitionAllowed({
      current: alreadyPublic,
      path: 'mcp',
      resolution: { lan: true, public: true },
      has_ddns: true,
      has_ws_lockout_confirmation: false,
    });
    expect(r.ok, 're-asserting an unchanged public mcp demanded a fresh ack').toBe(true);
  });

  it('⛔ turning mcp OFF never needs an acknowledgement', () => {
    // ⚠ The third condition, `resolution.public`, and deleting it was also
    // invisible. Without it the gate fires on ANY mcp write — so an owner who
    // wanted to REDUCE exposure would be asked to acknowledge going public
    // before they could stop being public. A prompt that blocks the safe
    // direction teaches people to click through prompts.
    // ⚠ FROM A PRIVATE mcp, ON PURPOSE. A first version started from an
    // already-public one, and that fixture masks the condition under test: the
    // neighbouring `!current.resolution.mcp.public` is already false there, so
    // the gate stays silent whether or not `resolution.public` is checked. Two
    // conditions agreeing again — the shape this whole sweep keeps finding.
    const base = buildState('lan_only');
    expect(base.resolution.mcp.public, 'fixture drifted — this must start private').toBe(false);
    const r = isPathResolutionTransitionAllowed({
      current: base,
      path: 'mcp',
      // LAN-only: exposure unchanged on the public side, and reduced nowhere.
      resolution: { lan: false, public: false },
      has_ddns: true,
      has_ws_lockout_confirmation: false,
    });
    expect(r.ok, 'a private mcp write demanded a public-exposure acknowledgement').toBe(true);
    if (r.ok) expect(r.resolution.mcp.public).toBe(false);
  });

  it('WS lockout disable phrase is the canonical literal', () => {
    expect(WS_LOCKOUT_DISABLE_PHRASE).toBe('disable ws');
  });
});

/** ⚠ FOUND BY MUTATION (2026-09-17). 13 mutations of `exposure-profile.ts`;
 *  6 survived 13 green tests. Every one is a guard whose neighbours happen to
 *  refuse the same fixture — the shape this whole sweep keeps finding. The
 *  cases below are chosen so ONLY the guard under test can decide. */
describe('D-148 W3.5 — exposure pre-flight: the guards nothing distinguished', () => {
  it('⛔ a LAN-only preset is allowed on a server with NO DDNS', () => {
    // ⚠ The existing `preset_unachievable_no_ddns` case pairs the `public`
    // preset with has_ddns:false, so `anyPathPublic(projected) &&` never
    // decided — dropping it left the suite green. This is the complement, and
    // it is the common case: most self-hosters never configure DDNS at all,
    // and a pre-flight that refuses `lan_only` for them blocks the one preset
    // that needs nothing.
    const r = isPresetTransitionAllowed({
      preset: 'lan_only',
      has_ddns: false,
      acknowledgement: baseAck(),
    });
    expect(r.ok, 'a LAN-only preset was refused for want of DDNS').toBe(true);
  });

  it('⛔ an unknown path role is refused (path_unknown)', () => {
    // ⚠ Only the PRESET helper had an unknown-value case; the path helper's
    // identical guard was unpinned.
    const r = isPathResolutionTransitionAllowed({
      current: buildState('lan_only'),
      path: 'not_a_path' as PathRole,
      resolution: { lan: true, public: false },
      has_ddns: true,
      has_ws_lockout_confirmation: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('path_unknown');
  });

  it('⛔ promoting a NON-mcp path public needs no acknowledgement', () => {
    // ⚠ Every ack-gate case uses path 'mcp', so `args.path === 'mcp'` never
    // decided. Without it the public-MCP modal would be raised for /webhooks
    // or /reception — asking the owner to consent to public MCP in order to
    // publish something that is not MCP.
    const r = isPathResolutionTransitionAllowed({
      current: buildState('lan_only'),
      path: 'webhooks',
      resolution: { lan: true, public: true },
      has_ddns: true,
      has_ws_lockout_confirmation: false,
    });
    expect(r.ok, 'a non-mcp promotion demanded the public-MCP acknowledgement').toBe(true);
  });

  it('⛔ dropping only /ws.public does NOT demand the lockout phrase', () => {
    // ⚠ The lockout fires when /ws leaves BOTH bits false. The existing cases
    // send `{lan:false, public:false}`, where `!resolution.lan` and
    // `!resolution.public` agree, so dropping the lan conjunct was invisible.
    // /ws staying on the LAN is not a lockout — the owner is still connected,
    // and demanding the phrase for it teaches them to type lockout phrases
    // that change nothing.
    const r = isPathResolutionTransitionAllowed({
      current: buildState('public'),
      path: 'ws',
      resolution: { lan: true, public: false },
      has_ddns: true,
      has_ws_lockout_confirmation: false,
    });
    expect(r.ok, 'reducing /ws to LAN-only demanded the lockout phrase').toBe(true);
  });

  it('⛔⛔ promoting a path public with no DDNS is refused — on the PROJECTION', () => {
    // ⛔ TWO MUTATIONS SURVIVED HERE: deleting the DDNS gate outright, and
    // pointing it at `current.resolution` instead of the projection. Both were
    // invisible because no test promotes anything public on a no-DDNS server.
    // Reading the pre-change table is the subtler one: the answer is always
    // "nothing public yet" for exactly the transition that is about to make
    // something public, so the gate would pass every first promotion — the
    // one it exists to catch.
    const r = isPathResolutionTransitionAllowed({
      current: buildState('lan_only'),
      path: 'webhooks',
      resolution: { lan: true, public: true },
      has_ddns: false,
      has_ws_lockout_confirmation: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('preset_unachievable_no_ddns');
  });

  it('a LAN-only path change is allowed with no DDNS', () => {
    // The complement that keeps the case above from passing on a blanket
    // "no DDNS ⇒ refuse everything".
    const r = isPathResolutionTransitionAllowed({
      current: buildState('lan_only'),
      path: 'webhooks',
      resolution: { lan: true, public: false },
      has_ddns: false,
      has_ws_lockout_confirmation: false,
    });
    expect(r.ok, 'a LAN-only path change was refused for want of DDNS').toBe(true);
  });
});

