/** D-148 W3.5b smoke — production path-routed wiring boot test.
 *
 *  Asserts the W3.5b substrate composes end-to-end:
 *    - `createServerHandlerSet(config)` → per-role handler decomposition
 *    - `createProductionPathListenerCoordinator` → owns the `PathListenerSet`
 *    - `createExposureStateMachine` → reapply at boot brings listeners up
 *    - The legacy alias map dispatches `/health`, `/auth/pair` (canonical
 *      ws role via alias), and the W3.5b 404 invariants hold for unknown
 *      paths + the placeholder MCP HTTP slot.
 *
 *  The test runs against an ephemeral LAN listener on port 0 + default
 *  exposure state (lan_only). Production bin.ts wires the same composition
 *  with additional deps (pairing manager, audit log, etc.); this smoke
 *  exercises the routing + listener lifecycle without those extras. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCertChainHolder } from '@recued/server-tls';
import { createServerHandlerSet } from '../server.js';
import {
  createProductionPathListenerCoordinator,
  type ProductionPathListenerCoordinator,
} from '../network/path-listener-coordinator.js';
import {
  createExposureStateMachine,
  createInMemoryExposureStore,
  DEFAULT_EXPOSURE_STATE,
  type ExposureStateMachine,
} from '../exposure/index.js';
import {
  deriveBootstrapDerivedExposureState,
  evaluateLanBindGate,
} from '../exposure/bootstrap.js';

describe('D-148 W3.5b — production path-routed bin smoke', () => {
  let coordinator: ProductionPathListenerCoordinator;
  let machine: ExposureStateMachine;
  let handlerSetClose: () => void;
  let port: number;

  beforeEach(async () => {
    const handlerSet = createServerHandlerSet({});
    handlerSetClose = handlerSet.close;
    coordinator = createProductionPathListenerCoordinator({
      handlers: handlerSet.handlers,
      upgradeHandlers: handlerSet.upgradeHandlers,
      legacyAliases: handlerSet.legacyAliases,
      cert_chain: createCertChainHolder(null),
      lan_port: 0,
    });
    machine = createExposureStateMachine({
      store: createInMemoryExposureStore(DEFAULT_EXPOSURE_STATE),
      listener: coordinator,
      effects: {
        recordAudit: async () => {},
        broadcast: async () => {},
      },
      ddns: { isConfigured: async () => false },
      bind_addresses: { lan: '127.0.0.1', public: '127.0.0.1' },
    });
    await machine.reapply();
    const lan = coordinator.status().find((s) => s.listener === 'lan');
    if (!lan || !lan.listening) {
      throw new Error(`smoke: LAN listener failed to bind (${lan?.failure ?? 'unknown'})`);
    }
    port = lan.port;
  });

  afterEach(async () => {
    handlerSetClose();
    await coordinator.stop();
  });

  it('binds the LAN listener at the persisted (default lan_only) resolution', () => {
    const statuses = coordinator.status();
    const lan = statuses.find((s) => s.listener === 'lan');
    expect(lan).toBeDefined();
    expect(lan?.listening).toBe(true);
    expect(lan?.tls).toBe(false);
    // Public listener stays unbound (lan_only baseline has no public bits).
    const pub = statuses.find((s) => s.listener === 'public');
    expect(pub?.listening).toBe(false);
  });

  it('serves /health on the LAN listener (canonical health role)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('routes /auth/pair via legacy alias → ws role handler', async () => {
    // The legacy alias dispatches /auth/pair to the ws role's handler.
    // With no pairing manager wired, the ws handler falls through to its
    // 404 catch-all (the /auth/pair branch requires `config.pairing`,
    // which isn't passed in this smoke harness). Either way the dispatch
    // happens — assert the listener didn't drop the connection.
    const res = await fetch(`http://127.0.0.1:${port}/auth/pair`, {
      method: 'POST',
      body: JSON.stringify({ code: 'x' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('not_found');
  });

  it('returns 404 for unknown paths (path-router fingerprint discipline)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/never-wired`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('not_found');
  });

  it('returns 404 for /mcp (HTTP MCP slot reserved at v1; production stays stdio)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  it('404s /reception/_health under lan_only baseline (reception role off by default)', async () => {
    // `DEFAULT_PATH_RESOLUTION.reception = { lan: false, public: false }`
    // per spec § A.7.1 — the lan_only preset keeps reception off so an
    // anonymous-visitor surface only appears after Mary explicitly toggles
    // it. The path-router emits the same generic 404 it does for unknown
    // paths (spec § A.6.2 fingerprint discipline) — Reception's role
    // handler is wired but the listener bit is false.
    const res = await fetch(`http://127.0.0.1:${port}/reception/_health`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('not_found');
  });

  it('serves /reception/_health once the reception role is toggled on', async () => {
    const res = await machine.setPathResolution({
      path: 'reception',
      resolution: { lan: true, public: false },
      changed_by_client_id: 'smoke-test',
    });
    expect(res.ok).toBe(true);
    // The coordinator rebuilds the listener-set on apply; the new LAN
    // port can differ from the original (OS-picked when `lan_port: 0`).
    // Read the post-rebind port from the coordinator status.
    const rebuiltLan = coordinator.status().find((s) => s.listener === 'lan');
    expect(rebuiltLan?.listening).toBe(true);
    const probe = await fetch(`http://127.0.0.1:${rebuiltLan!.port}/reception/_health`);
    expect(probe.status).toBe(200);
    const body = (await probe.json()) as { status: string };
    expect(body.status).toBe('ok');
  });
});

describe('D-148 W3.5b Codex P1 fold — bootstrap-derived initial exposure state', () => {
  it('keeps webhooks off when webhook_port=0 (no listener wired)', () => {
    const state = deriveBootstrapDerivedExposureState({
      webhook_port: 0,
      public_reachable: false,
    });
    expect(state.resolution.webhooks).toEqual({ lan: false, public: false });
  });

  it('enables webhooks LAN when webhook_port>0 (LAN-only deployment)', () => {
    const state = deriveBootstrapDerivedExposureState({
      webhook_port: 80,
      public_reachable: false,
    });
    expect(state.resolution.webhooks).toEqual({ lan: true, public: false });
    expect(state.resolution.health).toEqual({ lan: true, public: false });
  });

  it('enables webhooks + ws + health public when public_reachable=true (legacy public deployment)', () => {
    const state = deriveBootstrapDerivedExposureState({
      webhook_port: 443,
      public_reachable: true,
    });
    expect(state.resolution.webhooks).toEqual({ lan: true, public: true });
    expect(state.resolution.health).toEqual({ lan: true, public: true });
    expect(state.resolution.ws).toEqual({ lan: true, public: true });
    // MCP public stays off (ack-gated per § A.7.2)
    expect(state.resolution.mcp).toEqual({ lan: true, public: false });
    // Reception stays off (D-149 opt-in)
    expect(state.resolution.reception).toEqual({ lan: false, public: false });
  });

  it('labels mixed-shape states as `custom` (not one of the 3 presets)', () => {
    const state = deriveBootstrapDerivedExposureState({
      webhook_port: 443,
      public_reachable: true,
    });
    expect(state.derived_preset_label).toBe('custom');
    expect(state.public_mcp_acknowledgement.acknowledged).toBe(false);
  });
});

describe('D-148 W3.5b Codex P2 fold — LAN listener boot guard', () => {
  const defaultResolution = {
    health: { lan: true, public: false },
    ws: { lan: true, public: false },
    mcp: { lan: true, public: false },
    llm_gateway: { lan: true, public: false },
    webhooks: { lan: false, public: false },
    reception: { lan: false, public: false },
    oauth: { lan: false, public: false },
    ask: { lan: false, public: false },
    webclient: { lan: true, public: false },
  } as const;

  it('passes when LAN listener bound', () => {
    const verdict = evaluateLanBindGate(
      [
        { listener: 'lan', listening: true, bind_address: '127.0.0.1' },
        { listener: 'public', listening: false, bind_address: null },
      ],
      defaultResolution,
    );
    expect(verdict.fail).toBe(false);
  });

  it('fails when LAN listener required but not listening', () => {
    const verdict = evaluateLanBindGate(
      [
        {
          listener: 'lan',
          listening: false,
          bind_address: '127.0.0.1',
          failure: 'port_in_use',
        },
        { listener: 'public', listening: false, bind_address: null },
      ],
      defaultResolution,
    );
    expect(verdict.fail).toBe(true);
    if (verdict.fail) {
      expect(verdict.reason).toBe('port_in_use');
      expect(verdict.bind_address).toBe('127.0.0.1');
    }
  });

  it('passes when no path requires LAN (maintenance-like)', () => {
    const maintenanceResolution = {
      health: { lan: false, public: false },
      ws: { lan: false, public: false },
      mcp: { lan: false, public: false },
      llm_gateway: { lan: false, public: false },
      webhooks: { lan: false, public: false },
      reception: { lan: false, public: false },
      oauth: { lan: false, public: false },
      ask: { lan: false, public: false },
      webclient: { lan: false, public: false },
    };
    const verdict = evaluateLanBindGate(
      [
        { listener: 'lan', listening: false, bind_address: null },
        { listener: 'public', listening: false, bind_address: null },
      ],
      maintenanceResolution,
    );
    expect(verdict.fail).toBe(false);
  });

  it('does NOT fail when only the public listener fails (LAN still up)', () => {
    const verdict = evaluateLanBindGate(
      [
        { listener: 'lan', listening: true, bind_address: '127.0.0.1' },
        {
          listener: 'public',
          listening: false,
          bind_address: '0.0.0.0',
          failure: 'port_in_use',
        },
      ],
      {
        ...defaultResolution,
        // Some path also requires public; public-bind failure must NOT
        // fail boot (W3.5b: LAN listener is the admin channel; public
        // failure surfaces in the Reachability Doctor instead).
        health: { lan: true, public: true },
      },
    );
    expect(verdict.fail).toBe(false);
  });

  it('reports `unknown` when no LAN row is present in statuses', () => {
    const verdict = evaluateLanBindGate(
      [{ listener: 'public', listening: false, bind_address: null }],
      defaultResolution,
    );
    expect(verdict.fail).toBe(true);
    if (verdict.fail) {
      expect(verdict.reason).toBe('unknown');
    }
  });
});
