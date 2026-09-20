/** D-148 W3.5 — exposure state machine: extra coverage.
 *
 *  Concurrency, listener-coordination edge cases, audit-shape
 *  invariants. The "main" test file covers the spec acceptance lines;
 *  this file covers the substrate-level invariants every reviewer
 *  asks about (race conditions, partial failure, idempotency).
 */

import { describe, it, expect } from 'vitest';
import {
  PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
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
  type ActiveWsConnections,
  type ExposureStateStore,
  type PathListenerCoordinator,
  type ExposureSideEffects,
  type DdnsAvailability,
} from '../exposure/index.js';

const makeMachine = (
  args: {
    listener?: PathListenerCoordinator;
    effects?: ExposureSideEffects;
    ddns?: DdnsAvailability;
    clock?: () => number;
    store?: ExposureStateStore;
    activeWsConnections?: ActiveWsConnections;
  } = {},
) => {
  const audits: unknown[] = [];
  const broadcasts: ExposureChangedEvent[] = [];
  const applies: Array<{ resolution: Record<PathRole, PathResolution> }> = [];
  const listener: PathListenerCoordinator = args.listener ?? {
    apply: async ({ resolution, bind_addresses }) => {
      applies.push({ resolution });
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
  };
  const effects: ExposureSideEffects = args.effects ?? {
    recordAudit: async (entry) => {
      audits.push(entry);
    },
    broadcast: async (event) => {
      broadcasts.push(event);
    },
  };
  const ddns: DdnsAvailability = args.ddns ?? { isConfigured: async () => true };
  const store = args.store ?? createInMemoryExposureStore();
  const machine = createExposureStateMachine({
    store,
    listener,
    effects,
    ddns,
    bind_addresses: { lan: '10.0.0.1', public: '0.0.0.0' },
    clock: args.clock,
    ...(args.activeWsConnections
      ? { activeWsConnections: args.activeWsConnections }
      : {}),
  });
  return { machine, audits, broadcasts, applies, store };
};

describe('D-148 W3.5 — exposure substrate concurrency + edge cases', () => {
  it('serialises concurrent applyPreset calls', async () => {
    const { machine, audits } = makeMachine();
    const [a, b] = await Promise.all([
      machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'a' }),
      machine.applyPreset({ preset: 'public', changed_by_client_id: 'b' }),
    ]);
    // Both succeed (sequential), final state is the second.
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const state = await machine.current();
    expect(['lan_only', 'public']).toContain(state.derived_preset_label);
    // Two audit rows + two broadcast events — no deduping.
    expect(audits.length).toBe(2);
  });

  it('clock injection produces deterministic audit timestamps', async () => {
    let t = 1_000_000_000_000;
    const { machine } = makeMachine({ clock: () => ++t });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    const s = await machine.current();
    expect(s.last_changed_at).toBe(1_000_000_000_001);
  });

  it('reapply reuses persisted reason without re-emitting', async () => {
    const { machine, audits, broadcasts, applies } = makeMachine();
    await machine.applyPreset({
      preset: 'lan_only',
      changed_by_client_id: 'admin',
      reason: 'pinned',
    });
    audits.length = 0;
    broadcasts.length = 0;
    applies.length = 0;
    const out = await machine.reapply();
    expect(out.reason).toBe('pinned');
    expect(audits).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
    expect(applies).toHaveLength(1);
  });

  it('audit row carries free_text_confirmation only when ack=true succeeds', async () => {
    const { machine, audits } = makeMachine();
    await machine.setPublicMcpAcknowledgement({
      acknowledge: true,
      free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
      changed_by_client_id: 'admin',
    });
    const ackAudit = audits.find(
      (a) => (a as { action: string }).action === 'public_mcp_acknowledged',
    ) as { free_text_confirmation?: string };
    expect(ackAudit.free_text_confirmation).toBe(PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
    audits.length = 0;
    await machine.setPublicMcpAcknowledgement({
      acknowledge: false,
      changed_by_client_id: 'admin',
    });
    const offAudit = audits.find(
      (a) => (a as { action: string }).action === 'public_mcp_revoked',
    ) as { free_text_confirmation?: string };
    expect(offAudit.free_text_confirmation).toBeUndefined();
  });

  it('phrase-mismatch path leaves state untouched', async () => {
    const { machine, audits } = makeMachine();
    const before = await machine.current();
    const r = await machine.setPublicMcpAcknowledgement({
      acknowledge: true,
      free_text_confirmation: 'wrong',
      changed_by_client_id: 'admin',
    });
    expect(r.ok).toBe(false);
    const after = await machine.current();
    expect(after.public_mcp_acknowledgement.acknowledged).toBe(false);
    expect(after.last_changed_at).toBe(before.last_changed_at);
    expect(audits).toHaveLength(0);
  });

  it('lan_only preset: /ws + /mcp + /health lan; /webhooks + /reception off', () => {
    const resolution = applyPreset('lan_only', { acknowledged: false });
    expect(resolution.health).toEqual({ lan: true, public: false });
    expect(resolution.ws).toEqual({ lan: true, public: false });
    expect(resolution.mcp).toEqual({ lan: true, public: false });
    expect(resolution.webhooks).toEqual({ lan: false, public: false });
    expect(resolution.reception).toEqual({ lan: false, public: false });
  });

  it('listener apply errors propagate (operator visibility)', async () => {
    const { machine } = makeMachine({
      listener: {
        apply: async () => {
          throw new Error('listener-set down');
        },
      },
    });
    await expect(
      machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' }),
    ).rejects.toThrow(/listener-set down/);
  });

  it('audit emit error surfaces (operator visibility)', async () => {
    const { machine } = makeMachine({
      effects: {
        recordAudit: async () => {
          throw new Error('audit down');
        },
        broadcast: async () => {},
      },
    });
    await expect(
      machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' }),
    ).rejects.toThrow(/audit down/);
  });

  it('toggling back to lan_only after public closes every public bit', async () => {
    const { machine } = makeMachine();
    await machine.applyPreset({ preset: 'public', changed_by_client_id: 'admin' });
    const back = await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'admin' });
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error('unreachable');
    for (const role of ['ws', 'webhooks', 'reception', 'health'] as PathRole[]) {
      expect(back.state.resolution[role].public).toBe(false);
    }
  });
});

/** ⚠ FOUND BY MUTATION (2026-09-17). Ten mutations of `exposure/index.ts`
 *  survived 249 green tests across 13 suites. The six below are the ones with
 *  a constructible failure; the rest are recorded as equivalent in the sweep
 *  note at the bottom of this file.
 *
 *  What the gap had in common: every existing test drives the machine through
 *  a VALID sequence of gestures. Nothing seeds a store whose persisted row is
 *  already wrong, nothing keeps a reference after a transition returns, and
 *  nothing makes an injected dependency misbehave. Those are exactly the
 *  states a restart, a half-written row, or a real coordinator produces. */
describe('D-148 W3.5 — exposure state machine: adversarial inputs', () => {
  const seeded = (over: Partial<ExposureState>): ExposureStateStore =>
    createInMemoryExposureStore({ ...DEFAULT_EXPOSURE_STATE, ...over });

  it('⛔⛔ /mcp public promotion refuses a persisted ack whose phrase is NOT the canonical one', async () => {
    // ⛔ THIS IS THE I-13 CONSENT GATE. `setPathResolution` runs two checks in
    // sequence: well-formed, then acknowledged. A row saying `acknowledged:
    // true` with a junk phrase fails only the FIRST — so dropping it promotes
    // /mcp to the public internet on a consent record the user never typed.
    // Every existing ack test acknowledges through the machine, which cannot
    // produce this row; only a tampered or hand-edited store can.
    const { machine, applies } = makeMachine({
      store: seeded({
        public_mcp_acknowledgement: {
          acknowledged: true,
          free_text_confirmation: 'enable public mcp please',
        },
      }),
    });
    const res = await machine.setPathResolution({
      path: 'mcp',
      resolution: { lan: true, public: true },
      changed_by_client_id: 'c1',
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe('public_mcp_not_acknowledged');
    expect(applies, 'a refused promotion must not reach the listener').toHaveLength(0);
    expect((await machine.current()).resolution.mcp.public).toBe(false);
  });

  it('⛔⛔ revoking the acknowledgement DROPS /mcp.public', async () => {
    // ⛔ Consent is revocable or it is not consent. Without the demotion the
    // bit survives the un-ack, and `reapply()` re-binds /mcp publicly at the
    // next boot with the ack showing `acknowledged: false` — the audit trail
    // says the user withdrew while the listener says otherwise.
    const { machine } = makeMachine();
    await machine.setPublicMcpAcknowledgement({
      acknowledge: true,
      free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
      changed_by_client_id: 'c1',
    });
    const up = await machine.setPathResolution({
      path: 'mcp',
      resolution: { lan: true, public: true },
      changed_by_client_id: 'c1',
    });
    expect(up.ok).toBe(true);
    expect((await machine.current()).resolution.mcp.public).toBe(true);

    const off = await machine.setPublicMcpAcknowledgement({
      acknowledge: false,
      changed_by_client_id: 'c1',
    });
    expect(off.ok).toBe(true);
    const after = await machine.current();
    expect(after.public_mcp_acknowledgement.acknowledged).toBe(false);
    expect(
      after.resolution.mcp.public,
      '/mcp stayed public after the acknowledgement was revoked',
    ).toBe(false);
    expect(after.resolution.mcp.lan, 'revoking must not also drop the LAN bit').toBe(true);
  });

  it('⛔ a listener that RETAINS the applied resolution cannot mutate persisted state', async () => {
    // ⚠ The clone in `applyTransition` is taken AFTER `listener.apply`, so it
    // does not protect against a listener mutating during the call — it
    // protects against one that keeps the reference (a real coordinator holds
    // its last-applied table) and writes to it later. Passing the live object
    // through would make every such write a silent edit of cached exposure
    // state, with no audit row and no broadcast.
    let retained: Record<PathRole, PathResolution> | null = null;
    const { machine } = makeMachine({
      listener: {
        apply: async ({ resolution }) => {
          retained = resolution;
          return {
            lan: { listening: true, bind_address: '10.0.0.1' },
            public: { listening: false, bind_address: null },
          };
        },
      },
    });
    await machine.applyPreset({ preset: 'lan_only', changed_by_client_id: 'c1' });
    expect(retained).not.toBeNull();
    (retained as unknown as Record<PathRole, PathResolution>).mcp.public = true;
    expect(
      (await machine.current()).resolution.mcp.public,
      'the listener wrote through its retained reference into cached state',
    ).toBe(false);
  });

  it('⛔ a caller mutating current() cannot corrupt the bootstrap default for the NEXT machine', async () => {
    // ⚠ `DEFAULT_EXPOSURE_STATE` is a module-level const. `loadOrInit` clones
    // it; without the clone the first machine on a fresh server hands every
    // caller the module const itself, and one careless write poisons the
    // first-boot default for every machine in the process — including the one
    // a failed pairing recreates.
    const first = makeMachine().machine;
    const live = await first.current();
    live.resolution.mcp.public = true;
    live.public_mcp_acknowledgement.acknowledged = true;

    const second = await makeMachine().machine.current();
    expect(second.resolution.mcp.public, 'DEFAULT_EXPOSURE_STATE was mutated').toBe(false);
    expect(second.public_mcp_acknowledgement.acknowledged).toBe(false);
    expect(DEFAULT_EXPOSURE_STATE.resolution.mcp.public).toBe(false);
  });

  it("⛔ reapply() on a never-touched server records the actor as 'system', not empty", async () => {
    // ⚠ `DEFAULT_EXPOSURE_STATE.changed_by_client_id` is the empty string, so
    // the first boot's persisted row has no actor unless the fallback supplies
    // one. An empty actor in the exposure row reads as "unknown client did
    // this" in every later audit correlation.
    const { machine, store } = makeMachine();
    await machine.reapply();
    const persisted = await store.load();
    expect(persisted?.changed_by_client_id).toBe('system');
  });

  it('⛔ an ActiveWsConnections that THROWS counts as zero, not as connected', async () => {
    // ⚠ The count picks WHICH lockout phrase the operator must type. Failing
    // to a nonzero count would demand "disconnect webclients" on a server with
    // nobody connected — the operator types the phrase the UI shows, so the
    // visible effect is a phrase mismatch they cannot resolve. Failing to 0
    // keeps the gesture honest; the catch is the only thing enforcing it.
    const { machine } = makeMachine({
      activeWsConnections: {
        count: () => {
          throw new Error('listener registry unavailable');
        },
      },
    });
    const res = await machine.setPathResolution({
      path: 'ws',
      resolution: { lan: false, public: false },
      changed_by_client_id: 'c1',
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe('ws_lockout_unconfirmed');
    expect(res.ok === false && res.ws_lockout_required_phrase).toBe(WS_LOCKOUT_DISABLE_PHRASE);
    expect(res.ok === false && res.ws_lockout_active_clients).toBe(0);
  });
});

/* ─── Mutation sweep of `exposure/index.ts`, 2026-09-17 ───────────────────
 *  18 mutations × the 13 suites that import the module (matched by PATH —
 *  `index` as a basename matches 655 suites and is not a usable key).
 *  14 caught; the 4 below survive and are EQUIVALENT or unreachable. Recorded
 *  rather than tested so the next sweep does not re-derive them:
 *
 *  1. `if (acknowledge && !isAcknowledgementWellFormed(nextAck))` → dropped.
 *     EQUIVALENT BY CONSTRUCTION. `nextAck` is built two statements above with
 *     `acknowledged: true` and a `free_text_confirmation` that already passed
 *     `isValidPublicMcpAcknowledgementPhrase`; `isAcknowledgementWellFormed`
 *     checks exactly those two things. It cannot fail here. The comment calls
 *     it defense-in-depth and that is accurate — it guards the shape against a
 *     future edit to the builder, not against any input.
 *
 *  2. `typeof free_text_confirmation !== 'string'` → `=== undefined`.
 *     UNREACHABLE FROM THE WIRE. `handleExposureSetPublicMcpAcknowledgement`
 *     rejects a non-string with `badRequest` and forwards the field only when
 *     `typeof === 'string'`, so no rpc caller can reach it. It is live only
 *     for a direct in-process caller of the exported machine — worth keeping,
 *     since `isValidPublicMcpAcknowledgementPhrase` calls `.trim()` and would
 *     THROW rather than refuse.
 *
 *  3. `wsGoingFullyOff` dropping the `!nextWs.lan` conjunct. GATE-EQUIVALENT.
 *     `requiredWsLockoutPhrase` returns null whenever either bit stays on, so
 *     the gate cannot fire differently. The only observable difference is that
 *     a `public → lan_only` preset would gain an `active_ws_connections` field
 *     in its audit row. Real but cosmetic; not worth pinning the audit shape
 *     of a transition that never locks anyone out.
 *
 *  4. `if (inflight === p) inflight = null` → unconditional. NEVER TAKEN.
 *     Instrumented the `inflight !== p` branch and ran all 13 suites: 0 hits,
 *     concurrency test included. The owner registers `await p` on its own
 *     promise before any waiter can await it, so the owner's `finally` always
 *     runs first and `inflight` is still `p`. The guard becomes load-bearing
 *     the moment someone inserts an await between the `while` loop and
 *     `inflight = p` — keep it, but no test can distinguish it today.
 * ──────────────────────────────────────────────────────────────────────── */

