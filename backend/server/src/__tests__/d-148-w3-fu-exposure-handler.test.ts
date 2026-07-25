/** D-148 W3.FU — Per-path Exposure rpc handler tests.
 *
 *  Three rpc methods, one closed list each:
 *    - `exposure.apply_preset` → preset ∈ EXPOSURE_PRESETS
 *    - `exposure.set_path_resolution` → path ∈ PATH_ROLES + resolution shape
 *    - `exposure.set_public_mcp_acknowledgement` → acknowledge: bool +
 *      optional free-text confirmation phrase
 *
 *  Coverage:
 *    - `makeExposureHandlers(undefined)` returns undefined (slice drops).
 *    - `makeExposureHandlers(deps)` registers all three methods.
 *    - Unregistered caller (no `instance_id`) → `permission_denied`.
 *    - Wire-shape validators reject malformed args at the handler edge
 *      (preset / path / resolution / boolean acknowledge).
 *    - Successful mutation routes through the state machine + returns
 *      the post-state.
 *    - `ExposureMutationResult` `ok: false` branches surface as
 *      `RpcError` with the substrate's `NetworkErrorCode` carried as
 *      the rpc code; `/ws` lockout flavor folds the required phrase +
 *      active-client count into the error message for the modal.
 *    - Source-pin: `exposureRpcDeps.getMachine()` thunk resolves at
 *      call time so the rpc slice can register before the state machine
 *      is composed (boot-order invariant).
 *    - Source-pin: `exposure.` is in `MCP_RESERVED_RPC_PREFIXES` so
 *      MCP-channel agents cannot drive these mutators.
 *
 *  Spec: D-148 § A.7 + Amendment 2026-05-11. */

import { describe, expect, it } from 'vitest';
import {
  EXPOSURE_PRESETS,
  MCP_RESERVED_RPC_PREFIXES,
  PATH_ROLES,
  PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
  RpcError,
  SERVER_RPC_METHODS,
  WS_LOCKOUT_DISABLE_PHRASE,
  WS_LOCKOUT_DISCONNECT_PHRASE,
  isReservedLocalRpc,
  type ExposureChangedEvent,
  type ExposureState,
  type PathResolution,
  type PathRole,
} from '@recued/contracts';
import {
  createExposureStateMachine,
  createInMemoryExposureStore,
  type DdnsAvailability,
  type ExposureSideEffects,
  type ExposureStateMachine,
  type PathListenerCoordinator,
} from '../exposure/index.js';
import {
  handleExposureApplyPreset,
  handleExposureGet,
  handleExposureSetApex,
  handleExposureSetPathResolution,
  handleExposureSetPublicMcpAcknowledgement,
  makeExposureHandlers,
  type ExposureRpcDeps,
} from '../exposure-handler.js';
import type { RootApexMode } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Substrate scaffolding (minimal in-memory machine)
// ────────────────────────────────────────────────────────────────

const makeListener = (): PathListenerCoordinator => ({
  apply: async ({ resolution, bind_addresses }) => {
    const lanWanted = Object.values(resolution).some((r) => r.lan);
    const publicWanted = Object.values(resolution).some((r) => r.public);
    return {
      lan: {
        listening: lanWanted,
        bind_address: lanWanted ? bind_addresses.lan : null,
      },
      public: {
        listening: publicWanted,
        bind_address: publicWanted ? bind_addresses.public : null,
      },
    };
  },
});

const makeEffects = (): {
  effects: ExposureSideEffects;
  broadcasts: ExposureChangedEvent[];
} => {
  const broadcasts: ExposureChangedEvent[] = [];
  return {
    broadcasts,
    effects: {
      recordAudit: async () => {
        // Audit emit is exercised by the substrate suite; handler suite
        // only cares that the rpc surface threads `changed_by_client_id`
        // through. The state-machine post-state echo confirms that.
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

const makeMachine = (opts: { ddns?: boolean; active_ws?: number } = {}): ExposureStateMachine => {
  const store = createInMemoryExposureStore();
  return createExposureStateMachine({
    store,
    listener: makeListener(),
    effects: makeEffects().effects,
    ddns: makeDdns(opts.ddns ?? true),
    bind_addresses: { lan: '192.168.1.42', public: '0.0.0.0' },
    activeWsConnections: { count: () => opts.active_ws ?? 0 },
  });
};

const makeDeps = (machine: ExposureStateMachine): ExposureRpcDeps => ({
  getMachine: () => machine,
});

/** R26.2 Delta 2/3 — deps with an in-memory apex get/set for the
 *  `exposure.{get,set_apex}` apex tests. The `serve_webclient` consistency
 *  gate reads `resolution.webclient.public` from the machine (driven on
 *  `machine`) AND `isWebclientBundlePresent` (the boot-time verified-bundle
 *  probe, driven by `opts.bundlePresent`). */
const makeApexDeps = (
  machine: ExposureStateMachine,
  opts: { initial?: RootApexMode; bundlePresent?: boolean } = {},
): { deps: ExposureRpcDeps; current: () => RootApexMode } => {
  let apex: RootApexMode = opts.initial ?? 'redirect';
  return {
    current: () => apex,
    deps: {
      getMachine: () => machine,
      apex: {
        get: () => apex,
        set: (mode) => {
          apex = mode;
        },
        isWebclientBundlePresent: () => opts.bundlePresent === true,
      },
    },
  };
};

const pairedCaller = { instance_id: 'paired-1' };
const unregisteredCaller = { instance_id: null };

// ────────────────────────────────────────────────────────────────
// Slice factory
// ────────────────────────────────────────────────────────────────

describe('makeExposureHandlers', () => {
  it('returns undefined when deps are absent (slice drops; dispatcher → not_configured)', () => {
    expect(makeExposureHandlers(undefined)).toBeUndefined();
  });

  it('registers all five exposure methods when deps are present', () => {
    const slice = makeExposureHandlers(makeDeps(makeMachine()));
    expect(slice).toBeDefined();
    expect(slice!.methods).toEqual([
      'exposure.apply_preset',
      'exposure.set_path_resolution',
      'exposure.set_public_mcp_acknowledgement',
      'exposure.get',
      'exposure.set_apex',
    ]);
    expect(typeof slice!.handlers['exposure.apply_preset']).toBe('function');
    expect(typeof slice!.handlers['exposure.set_path_resolution']).toBe('function');
    expect(typeof slice!.handlers['exposure.set_public_mcp_acknowledgement']).toBe('function');
    expect(typeof slice!.handlers['exposure.get']).toBe('function');
    expect(typeof slice!.handlers['exposure.set_apex']).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────
// exposure.get — R26.2 Delta 1 cold-load read
// ────────────────────────────────────────────────────────────────

describe('handleExposureGet', () => {
  it('returns the current state for a paired caller (no audit/broadcast)', async () => {
    const { effects, broadcasts } = makeEffects();
    const store = createInMemoryExposureStore();
    const machine = createExposureStateMachine({
      store,
      listener: makeListener(),
      effects,
      ddns: makeDdns(true),
      bind_addresses: { lan: '192.168.1.42', public: '0.0.0.0' },
      activeWsConnections: { count: () => 0 },
    });
    const result = await handleExposureGet(makeDeps(machine), pairedCaller);
    // Cold machine initialises from the default (lan_only) state.
    expect(result.state.derived_preset_label).toBe('lan_only');
    expect(result.state.resolution.ws.lan).toBe(true);
    // R26.2 Delta 2 — apex falls back to `redirect` when deps.apex is unwired.
    expect(result.apex_mode).toBe('redirect');
    // Pure read — never emits a broadcast.
    expect(broadcasts).toHaveLength(0);
  });

  it('hydrates the wired apex mode (R26.2 Delta 2)', async () => {
    const { deps } = makeApexDeps(makeMachine(), { initial: 'not_found' });
    const result = await handleExposureGet(deps, pairedCaller);
    expect(result.apex_mode).toBe('not_found');
  });

  it('rejects unregistered callers (no instance_id)', async () => {
    await expect(
      handleExposureGet(makeDeps(makeMachine()), unregisteredCaller),
    ).rejects.toThrow(/requires a paired client/);
  });

  it('rejects a missing caller object entirely', async () => {
    await expect(
      handleExposureGet(makeDeps(makeMachine()), undefined),
    ).rejects.toThrow(/requires a paired client/);
  });

  it('reflects a prior mutation (reads back the applied preset)', async () => {
    const machine = makeMachine({ ddns: true });
    await handleExposureApplyPreset(
      makeDeps(machine),
      { preset: 'public' },
      pairedCaller,
    );
    const result = await handleExposureGet(makeDeps(machine), pairedCaller);
    expect(result.state.derived_preset_label).toBe('public');
  });
});

// ────────────────────────────────────────────────────────────────
// exposure.set_apex — R26.2 Delta 2 apex setter + consistency gate
// ────────────────────────────────────────────────────────────────

describe('handleExposureSetApex', () => {
  it('rejects unregistered callers', async () => {
    const { deps } = makeApexDeps(makeMachine());
    await expect(
      handleExposureSetApex(deps, { apex_mode: 'not_found' }, unregisteredCaller),
    ).rejects.toThrow(/requires a paired client/);
  });

  it('rejects an unknown mode (apex_mode_unknown)', async () => {
    const { deps } = makeApexDeps(makeMachine());
    await expect(
      handleExposureSetApex(deps, { apex_mode: 'banana' }, pairedCaller),
    ).rejects.toMatchObject({ code: 'apex_mode_unknown' });
  });

  it('surfaces not_configured when the apex dep is unwired', async () => {
    await expect(
      handleExposureSetApex(makeDeps(makeMachine()), { apex_mode: 'not_found' }, pairedCaller),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('sets redirect / not_found without any consistency gate', async () => {
    const { deps, current } = makeApexDeps(makeMachine(), { initial: 'redirect' });
    const res = await handleExposureSetApex(deps, { apex_mode: 'not_found' }, pairedCaller);
    expect(res.apex_mode).toBe('not_found');
    expect(current()).toBe('not_found');
  });

  it('rejects serve_reception when /reception is not public (apex_reception_not_public)', async () => {
    // Default machine = lan_only → reception not public.
    const { deps, current } = makeApexDeps(makeMachine({ ddns: true }), { initial: 'redirect' });
    await expect(
      handleExposureSetApex(deps, { apex_mode: 'serve_reception' }, pairedCaller),
    ).rejects.toMatchObject({ code: 'apex_reception_not_public' });
    // The persisted mode is untouched on rejection.
    expect(current()).toBe('redirect');
  });

  it('allows serve_reception once /reception is public', async () => {
    const machine = makeMachine({ ddns: true });
    // The `public` preset turns /reception public.
    await handleExposureApplyPreset(makeDeps(machine), { preset: 'public' }, pairedCaller);
    const { deps, current } = makeApexDeps(machine, { initial: 'redirect' });
    const res = await handleExposureSetApex(deps, { apex_mode: 'serve_reception' }, pairedCaller);
    expect(res.apex_mode).toBe('serve_reception');
    expect(current()).toBe('serve_reception');
  });

  it('rejects serve_webclient when /webclient is not public (even with a bundle)', async () => {
    // Default machine = lan_only → webclient.public false. The `public`
    // preset deliberately leaves webclient public-off, so it stays an
    // explicit per-row opt-in. A deployed bundle alone is not enough.
    const { deps, current } = makeApexDeps(makeMachine({ ddns: true }), {
      initial: 'redirect',
      bundlePresent: true,
    });
    await expect(
      handleExposureSetApex(deps, { apex_mode: 'serve_webclient' }, pairedCaller),
    ).rejects.toMatchObject({ code: 'apex_webclient_unavailable' });
    // The persisted mode is untouched on rejection.
    expect(current()).toBe('redirect');
  });

  it('rejects serve_webclient when /webclient is public but no bundle is deployed', async () => {
    // The setter applies the SAME servability predicate as the live root
    // handler — without a verified bundle the apex would 302 to a /webclient/
    // that 404s, so set_apex must not report success.
    const machine = makeMachine({ ddns: true });
    await handleExposureSetPathResolution(
      makeDeps(machine),
      { path: 'webclient', resolution: { lan: true, public: true } },
      pairedCaller,
    );
    const { deps, current } = makeApexDeps(machine, {
      initial: 'redirect',
      bundlePresent: false,
    });
    await expect(
      handleExposureSetApex(deps, { apex_mode: 'serve_webclient' }, pairedCaller),
    ).rejects.toMatchObject({ code: 'apex_webclient_unavailable' });
    expect(current()).toBe('redirect');
  });

  it('allows serve_webclient once /webclient is public AND a bundle is deployed', async () => {
    const machine = makeMachine({ ddns: true });
    // webclient.public is an explicit per-row opt-in (not snapped on by the
    // `public` preset), so set it directly via set_path_resolution.
    await handleExposureSetPathResolution(
      makeDeps(machine),
      { path: 'webclient', resolution: { lan: true, public: true } },
      pairedCaller,
    );
    const { deps, current } = makeApexDeps(machine, {
      initial: 'redirect',
      bundlePresent: true,
    });
    const res = await handleExposureSetApex(deps, { apex_mode: 'serve_webclient' }, pairedCaller);
    expect(res.apex_mode).toBe('serve_webclient');
    expect(current()).toBe('serve_webclient');
  });
});

// ────────────────────────────────────────────────────────────────
// Caller-identity gate
// ────────────────────────────────────────────────────────────────

describe('caller-identity gate', () => {
  it('exposure.apply_preset rejects unregistered callers (no instance_id)', async () => {
    await expect(
      handleExposureApplyPreset(
        makeDeps(makeMachine()),
        { preset: 'lan_only' },
        unregisteredCaller,
      ),
    ).rejects.toThrow(/requires a paired client/);
  });

  it('exposure.set_path_resolution rejects unregistered callers', async () => {
    await expect(
      handleExposureSetPathResolution(
        makeDeps(makeMachine()),
        { path: 'webhooks', resolution: { lan: true, public: false } },
        unregisteredCaller,
      ),
    ).rejects.toThrow(/requires a paired client/);
  });

  it('exposure.set_public_mcp_acknowledgement rejects unregistered callers', async () => {
    await expect(
      handleExposureSetPublicMcpAcknowledgement(
        makeDeps(makeMachine()),
        { acknowledge: false },
        unregisteredCaller,
      ),
    ).rejects.toThrow(/requires a paired client/);
  });

  it('rejects callers with missing caller object entirely', async () => {
    await expect(
      handleExposureApplyPreset(
        makeDeps(makeMachine()),
        { preset: 'lan_only' },
        undefined,
      ),
    ).rejects.toThrow(/requires a paired client/);
  });
});

// ────────────────────────────────────────────────────────────────
// Wire-shape validators
// ────────────────────────────────────────────────────────────────

describe('wire-shape validators (bad_request)', () => {
  it('apply_preset rejects unknown preset', async () => {
    await expect(
      handleExposureApplyPreset(
        makeDeps(makeMachine()),
        { preset: 'overdrive' },
        pairedCaller,
      ),
    ).rejects.toThrow(/preset must be one of/);
  });

  it('apply_preset rejects non-string preset (number)', async () => {
    await expect(
      handleExposureApplyPreset(
        makeDeps(makeMachine()),
        { preset: 42 },
        pairedCaller,
      ),
    ).rejects.toThrow(/preset must be one of/);
  });

  it('apply_preset rejects non-string lockout_confirmation_phrase', async () => {
    await expect(
      handleExposureApplyPreset(
        makeDeps(makeMachine()),
        { preset: 'lan_only', lockout_confirmation_phrase: 123 },
        pairedCaller,
      ),
    ).rejects.toThrow(/lockout_confirmation_phrase must be a string/);
  });

  it('apply_preset rejects non-string reason', async () => {
    await expect(
      handleExposureApplyPreset(
        makeDeps(makeMachine()),
        { preset: 'lan_only', reason: { not: 'a string' } },
        pairedCaller,
      ),
    ).rejects.toThrow(/reason must be a string/);
  });

  it('set_path_resolution rejects unknown path', async () => {
    await expect(
      handleExposureSetPathResolution(
        makeDeps(makeMachine()),
        { path: 'not_a_path', resolution: { lan: true, public: false } },
        pairedCaller,
      ),
    ).rejects.toThrow(/path must be one of/);
  });

  it('set_path_resolution rejects missing resolution', async () => {
    await expect(
      handleExposureSetPathResolution(
        makeDeps(makeMachine()),
        { path: 'webhooks' },
        pairedCaller,
      ),
    ).rejects.toThrow(/resolution must be/);
  });

  it('set_path_resolution rejects malformed resolution (non-boolean lan)', async () => {
    await expect(
      handleExposureSetPathResolution(
        makeDeps(makeMachine()),
        { path: 'webhooks', resolution: { lan: 'true', public: false } },
        pairedCaller,
      ),
    ).rejects.toThrow(/resolution must be/);
  });

  it('set_public_mcp_acknowledgement rejects non-boolean acknowledge', async () => {
    await expect(
      handleExposureSetPublicMcpAcknowledgement(
        makeDeps(makeMachine()),
        { acknowledge: 'yes' },
        pairedCaller,
      ),
    ).rejects.toThrow(/acknowledge must be a boolean/);
  });

  it('set_public_mcp_acknowledgement rejects non-string free_text_confirmation', async () => {
    await expect(
      handleExposureSetPublicMcpAcknowledgement(
        makeDeps(makeMachine()),
        { acknowledge: true, free_text_confirmation: 42 },
        pairedCaller,
      ),
    ).rejects.toThrow(/free_text_confirmation must be a string/);
  });
});

// ────────────────────────────────────────────────────────────────
// Success paths — substrate result → wire response
// ────────────────────────────────────────────────────────────────

describe('apply_preset success path', () => {
  it('lan_only preset returns the post-state + clients_disconnected: 0', async () => {
    const machine = makeMachine();
    const out = await handleExposureApplyPreset(
      makeDeps(machine),
      { preset: 'lan_only', reason: 'baseline' },
      pairedCaller,
    );
    expect(out.state.derived_preset_label).toBe('lan_only');
    expect(out.state.changed_by_client_id).toBe('paired-1');
    expect(out.state.reason).toBe('baseline');
    expect(out.state.resolution.ws).toEqual({ lan: true, public: false });
    expect(out.clients_disconnected).toBe(0);
  });

  it('public preset returns post-state with /mcp.public still false (no ack)', async () => {
    const machine = makeMachine();
    const out = await handleExposureApplyPreset(
      makeDeps(machine),
      { preset: 'public' },
      pairedCaller,
    );
    expect(out.state.derived_preset_label).toBe('public');
    expect(out.state.resolution.mcp.public).toBe(false);
    expect(out.state.resolution.webhooks).toEqual({ lan: true, public: true });
    expect(out.clients_disconnected).toBe(0);
  });
});

describe('set_path_resolution success path', () => {
  it('promotes /webhooks to lan+public (DDNS configured)', async () => {
    const machine = makeMachine({ ddns: true });
    // Start with lan_only baseline.
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    const out = await handleExposureSetPathResolution(
      makeDeps(machine),
      { path: 'webhooks', resolution: { lan: true, public: true }, reason: 'enable inbound' },
      pairedCaller,
    );
    expect(out.state.resolution.webhooks).toEqual({ lan: true, public: true });
    expect(out.state.changed_by_client_id).toBe('paired-1');
    expect(out.clients_disconnected).toBe(0);
  });
});

describe('set_public_mcp_acknowledgement success path', () => {
  it('acknowledges with the canonical phrase', async () => {
    const machine = makeMachine({ ddns: false });
    const out = await handleExposureSetPublicMcpAcknowledgement(
      makeDeps(machine),
      {
        acknowledge: true,
        free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
      },
      pairedCaller,
    );
    expect(out.state.public_mcp_acknowledgement.acknowledged).toBe(true);
    expect(out.state.public_mcp_acknowledgement.acknowledged_by_client_id).toBe('paired-1');
    expect(out.clients_disconnected).toBe(0);
  });

  it('revokes acknowledgement (no phrase required for demotion)', async () => {
    const machine = makeMachine({ ddns: false });
    // Ack first.
    await machine.setPublicMcpAcknowledgement({
      acknowledge: true,
      free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
      changed_by_client_id: 'admin',
    });
    const out = await handleExposureSetPublicMcpAcknowledgement(
      makeDeps(machine),
      { acknowledge: false },
      pairedCaller,
    );
    expect(out.state.public_mcp_acknowledgement.acknowledged).toBe(false);
    expect(out.clients_disconnected).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Codex W3.FU P1 fold — `/ws` lockout drain after success
// ────────────────────────────────────────────────────────────────

describe('Codex W3.FU P1 fold — /ws lockout drains active clients', () => {
  const makeDepsWithDrain = (
    machine: ExposureStateMachine,
    drain: (reason: string) => number,
  ): ExposureRpcDeps => ({
    getMachine: () => machine,
    closeWsClientsForLockout: drain,
  });

  it('apply_preset(maintenance) with active WS → calls drain + echoes count', async () => {
    const machine = makeMachine({ active_ws: 2 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    let drainCalledWith: string | undefined;
    const out = await handleExposureApplyPreset(
      makeDepsWithDrain(machine, (reason) => {
        drainCalledWith = reason;
        return 2;
      }),
      {
        preset: 'maintenance',
        lockout_confirmation_phrase: WS_LOCKOUT_DISCONNECT_PHRASE,
      },
      pairedCaller,
    );
    expect(drainCalledWith).toBe('preset:maintenance');
    expect(out.clients_disconnected).toBe(2);
    expect(out.state.resolution.ws).toEqual({ lan: false, public: false });
  });

  it('apply_preset(lan_only) with no /ws change → drain NOT called', async () => {
    const machine = makeMachine();
    let drainCalled = false;
    const out = await handleExposureApplyPreset(
      makeDepsWithDrain(machine, () => {
        drainCalled = true;
        return 99;
      }),
      { preset: 'lan_only' },
      pairedCaller,
    );
    expect(drainCalled).toBe(false);
    expect(out.clients_disconnected).toBe(0);
  });

  it('set_path_resolution({ path: ws, lan: false, public: false }) → drain called', async () => {
    const machine = makeMachine({ active_ws: 1 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    const out = await handleExposureSetPathResolution(
      makeDepsWithDrain(machine, () => 1),
      {
        path: 'ws',
        resolution: { lan: false, public: false },
        lockout_confirmation_phrase: WS_LOCKOUT_DISCONNECT_PHRASE,
      },
      pairedCaller,
    );
    expect(out.clients_disconnected).toBe(1);
    expect(out.state.resolution.ws).toEqual({ lan: false, public: false });
  });

  it('drain callback absent → clients_disconnected: 0 (test-composition path)', async () => {
    const machine = makeMachine({ active_ws: 0 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    const out = await handleExposureApplyPreset(
      { getMachine: () => machine },
      {
        preset: 'maintenance',
        lockout_confirmation_phrase: WS_LOCKOUT_DISABLE_PHRASE,
      },
      pairedCaller,
    );
    expect(out.clients_disconnected).toBe(0);
  });

  it('drain callback throws → success still returned + clients_disconnected: 0', async () => {
    const machine = makeMachine({ active_ws: 0 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    const out = await handleExposureApplyPreset(
      makeDepsWithDrain(machine, () => {
        throw new Error('boom');
      }),
      {
        preset: 'maintenance',
        lockout_confirmation_phrase: WS_LOCKOUT_DISABLE_PHRASE,
      },
      pairedCaller,
    );
    // State already persisted + broadcast inside the substrate; drain
    // failure mustn't fail the rpc, just degrade to count=0.
    expect(out.clients_disconnected).toBe(0);
    expect(out.state.resolution.ws).toEqual({ lan: false, public: false });
  });

  it('public_mcp_acknowledgement never triggers the drain (no /ws change)', async () => {
    const machine = makeMachine({ ddns: false });
    let drainCalled = false;
    const out = await handleExposureSetPublicMcpAcknowledgement(
      makeDepsWithDrain(machine, () => {
        drainCalled = true;
        return 5;
      }),
      {
        acknowledge: true,
        free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
      },
      pairedCaller,
    );
    expect(drainCalled).toBe(false);
    expect(out.clients_disconnected).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Substrate gate errors → RpcError with stable codes
// ────────────────────────────────────────────────────────────────

describe('substrate gate errors → RpcError', () => {
  it('public preset with DDNS unconfigured → preset_unachievable_no_ddns + status 400', async () => {
    const machine = makeMachine({ ddns: false });
    let caught: unknown;
    try {
      await handleExposureApplyPreset(
        makeDeps(machine),
        { preset: 'public' },
        pairedCaller,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcError);
    const e = caught as RpcError;
    expect(e.code).toBe('preset_unachievable_no_ddns');
    // Codex W3.FU P3 fold — explicit 400 on every substrate-gate
    // error so the dispatcher doesn't default to 500.
    expect(e.status).toBe(400);
    // No `details` slot for non-lockout codes — the code is
    // self-describing.
    expect(e.details).toBeUndefined();
  });

  it('maintenance preset with active WS but no phrase → ws_lockout_unconfirmed with structured details (P2)', async () => {
    const machine = makeMachine({ active_ws: 2 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    let caught: unknown;
    try {
      await handleExposureApplyPreset(
        makeDeps(machine),
        { preset: 'maintenance' },
        pairedCaller,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcError);
    const e = caught as RpcError;
    expect(e.code).toBe('ws_lockout_unconfirmed');
    expect(e.status).toBe(400);
    // Codex W3.FU P2 fold — structured details, not just packed-into-
    // message. The renderer reads typed fields without parsing.
    expect(e.details).toEqual({
      required_phrase: WS_LOCKOUT_DISCONNECT_PHRASE,
      active_ws_connections: 2,
    });
    // Message still carries the human-readable form for logs.
    expect(e.message).toContain(WS_LOCKOUT_DISCONNECT_PHRASE);
    expect(e.message).toContain('active_ws_connections=2');
  });

  it('maintenance preset with active=0 + no phrase → ws_lockout_unconfirmed with disable-phrase details', async () => {
    const machine = makeMachine({ active_ws: 0 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    let caught: unknown;
    try {
      await handleExposureApplyPreset(
        makeDeps(machine),
        { preset: 'maintenance' },
        pairedCaller,
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as RpcError;
    expect(e.details).toEqual({
      required_phrase: WS_LOCKOUT_DISABLE_PHRASE,
      active_ws_connections: 0,
    });
  });

  it('maintenance preset with wrong phrase → ws_lockout_phrase_mismatch + details', async () => {
    const machine = makeMachine({ active_ws: 0 });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    let caught: unknown;
    try {
      await handleExposureApplyPreset(
        makeDeps(machine),
        { preset: 'maintenance', lockout_confirmation_phrase: 'wrong phrase' },
        pairedCaller,
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as RpcError;
    expect(e.code).toBe('ws_lockout_phrase_mismatch');
    expect(e.status).toBe(400);
    // Phrase mismatch path also carries structured details so the
    // renderer can re-verify the user's input against the same
    // server-side required phrase + count.
    expect(e.details?.required_phrase).toBe(WS_LOCKOUT_DISABLE_PHRASE);
  });

  it('set_path_resolution: promoting /mcp.public without ack → public_mcp_not_acknowledged + status 400', async () => {
    const machine = makeMachine({ ddns: true });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    let caught: unknown;
    try {
      await handleExposureSetPathResolution(
        makeDeps(machine),
        { path: 'mcp', resolution: { lan: true, public: true } },
        pairedCaller,
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as RpcError;
    expect(e.code).toBe('public_mcp_not_acknowledged');
    expect(e.status).toBe(400);
  });

  it('set_public_mcp_acknowledgement with wrong phrase → public_mcp_phrase_mismatch + status 400', async () => {
    const machine = makeMachine({ ddns: false });
    let caught: unknown;
    try {
      await handleExposureSetPublicMcpAcknowledgement(
        makeDeps(machine),
        { acknowledge: true, free_text_confirmation: 'Enable Public MCP' },
        pairedCaller,
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as RpcError;
    expect(e.code).toBe('public_mcp_phrase_mismatch');
    expect(e.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────
// Codex W3.FU P3 fold — explicit HTTP-class statuses
// ────────────────────────────────────────────────────────────────

describe('Codex W3.FU P3 fold — explicit statuses on handler-edge throws', () => {
  it('unregistered caller → status 403 (permission_denied)', async () => {
    let caught: unknown;
    try {
      await handleExposureApplyPreset(
        makeDeps(makeMachine()),
        { preset: 'lan_only' },
        unregisteredCaller,
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as RpcError;
    expect(e.code).toBe('permission_denied');
    expect(e.status).toBe(403);
  });

  it('malformed preset → status 400 (bad_request)', async () => {
    let caught: unknown;
    try {
      await handleExposureApplyPreset(
        makeDeps(makeMachine()),
        { preset: 'overdrive' },
        pairedCaller,
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as RpcError;
    expect(e.code).toBe('bad_request');
    expect(e.status).toBe(400);
  });

  it('malformed path → status 400', async () => {
    let caught: unknown;
    try {
      await handleExposureSetPathResolution(
        makeDeps(makeMachine()),
        { path: 'not_a_path', resolution: { lan: true, public: false } },
        pairedCaller,
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as RpcError).status).toBe(400);
  });

  it('malformed resolution → status 400', async () => {
    let caught: unknown;
    try {
      await handleExposureSetPathResolution(
        makeDeps(makeMachine()),
        { path: 'webhooks', resolution: { lan: 'true' as unknown, public: false } as unknown },
        pairedCaller,
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as RpcError).status).toBe(400);
  });

  it('non-boolean acknowledge → status 400', async () => {
    let caught: unknown;
    try {
      await handleExposureSetPublicMcpAcknowledgement(
        makeDeps(makeMachine()),
        { acknowledge: 'yes' },
        pairedCaller,
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as RpcError).status).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────
// Boot-order invariant — `getMachine` thunk resolves at call time
// ────────────────────────────────────────────────────────────────

describe('boot-order invariant', () => {
  it('getMachine() thunk is invoked per rpc call (not at slice construction)', async () => {
    let machineRef: ExposureStateMachine | undefined;
    const deps: ExposureRpcDeps = {
      getMachine: () => {
        if (!machineRef) throw new Error('machine not yet wired');
        return machineRef;
      },
    };
    // Slice constructs fine even with machine undefined — same shape
    // bin.ts uses (forward-declared exposureMachineRef + thunk wired
    // into deps before the state machine is composed).
    const slice = makeExposureHandlers(deps);
    expect(slice).toBeDefined();

    // Calling before the machine is wired throws — fail-loud is
    // intentional (boot-order invariant violation).
    await expect(
      handleExposureApplyPreset(deps, { preset: 'lan_only' }, pairedCaller),
    ).rejects.toThrow(/machine not yet wired/);

    // After wiring, the same deps work.
    machineRef = makeMachine();
    const out = await handleExposureApplyPreset(
      deps,
      { preset: 'lan_only' },
      pairedCaller,
    );
    expect(out.state.derived_preset_label).toBe('lan_only');
  });
});

// ────────────────────────────────────────────────────────────────
// Channel-isolation ratchet
// ────────────────────────────────────────────────────────────────

describe('channel-isolation ratchet', () => {
  it('every exposure.* method is in SERVER_RPC_METHODS', () => {
    const methods = [
      'exposure.apply_preset',
      'exposure.set_path_resolution',
      'exposure.set_public_mcp_acknowledgement',
      'exposure.get',
      'exposure.set_apex',
    ];
    for (const m of methods) {
      expect((SERVER_RPC_METHODS as readonly string[]).includes(m)).toBe(true);
    }
  });

  it('exposure.* prefix is in MCP_RESERVED_RPC_PREFIXES (channel-isolation invariant)', () => {
    expect((MCP_RESERVED_RPC_PREFIXES as readonly string[]).includes('exposure.')).toBe(true);
  });

  it('each exposure.* method is recognised as local-UI-only by isReservedLocalRpc', () => {
    expect(isReservedLocalRpc('exposure.apply_preset')).toBe(true);
    expect(isReservedLocalRpc('exposure.set_path_resolution')).toBe(true);
    expect(isReservedLocalRpc('exposure.set_public_mcp_acknowledgement')).toBe(true);
    expect(isReservedLocalRpc('exposure.get')).toBe(true);
    expect(isReservedLocalRpc('exposure.set_apex')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Source pins — handler-edge wiring discipline
// ────────────────────────────────────────────────────────────────

describe('source pins', () => {
  it('handler threads pairedCaller.instance_id into changed_by_client_id', async () => {
    const machine = makeMachine();
    const out = await handleExposureApplyPreset(
      makeDeps(machine),
      { preset: 'lan_only' },
      { instance_id: 'mary-laptop-7' },
    );
    expect(out.state.changed_by_client_id).toBe('mary-laptop-7');
  });

  it('coverage: every PATH_ROLE survives the path validator', async () => {
    const machine = makeMachine({ ddns: true });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    const observed: PathRole[] = [];
    for (const role of PATH_ROLES) {
      // Each role accepts a `{ lan: true, public: false }` mutation
      // (no public flip → no DDNS gate; no /mcp.public flip → no ack
      // gate; /ws stays enabled → no lockout gate).
      const out = await handleExposureSetPathResolution(
        makeDeps(machine),
        { path: role, resolution: { lan: true, public: false } },
        pairedCaller,
      );
      observed.push(role);
      void (out.state satisfies ExposureState);
    }
    expect(observed).toEqual([...PATH_ROLES]);
  });

  it('coverage: every preset survives the preset validator', async () => {
    for (const preset of EXPOSURE_PRESETS) {
      const machine = makeMachine({ ddns: true, active_ws: 0 });
      // `maintenance` projects /ws fully off; supply the disable phrase.
      const phrase = preset === 'maintenance' ? WS_LOCKOUT_DISABLE_PHRASE : undefined;
      const out = await handleExposureApplyPreset(
        makeDeps(machine),
        {
          preset,
          ...(phrase !== undefined ? { lockout_confirmation_phrase: phrase } : {}),
        },
        pairedCaller,
      );
      expect(out.state.derived_preset_label).toBe(preset);
    }
  });

  it('PathResolution shape coverage: { lan, public } both booleans accepted', async () => {
    const machine = makeMachine({ ddns: true });
    const cases: PathResolution[] = [
      { lan: true, public: false },
      { lan: false, public: false },
      { lan: true, public: true },
    ];
    for (const r of cases) {
      const out = await handleExposureSetPathResolution(
        makeDeps(machine),
        { path: 'webhooks', resolution: r },
        pairedCaller,
      );
      expect(out.state.resolution.webhooks).toEqual(r);
    }
  });
});
