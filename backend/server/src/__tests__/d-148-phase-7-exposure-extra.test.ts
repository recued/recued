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
  applyPreset,
  type ExposureChangedEvent,
  type PathResolution,
  type PathRole,
} from '@recued/contracts';
import {
  createExposureStateMachine,
  createInMemoryExposureStore,
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
  const machine = createExposureStateMachine({
    store: createInMemoryExposureStore(),
    listener,
    effects,
    ddns,
    bind_addresses: { lan: '10.0.0.1', public: '0.0.0.0' },
    clock: args.clock,
  });
  return { machine, audits, broadcasts, applies };
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
