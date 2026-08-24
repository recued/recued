/** D-169 P1 — contracts surface ratchet.
 *
 *  Asserts the new types + method-name additions are exported + reserved
 *  on the MCP side. A future change that drops one of these would fail
 *  the ratchet here rather than at a downstream caller.
 *
 *  Spec: D-169 § N.5 / N.6 / A.6. */

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MCP_RESERVED_RPC_PREFIXES,
  SERVER_RPC_METHOD_SET,
  isReservedLocalRpc,
} from '../index.js';
import type {
  NotificationBridgeModeRow,
  NotificationBridgeRow,
  NotificationSetBridgeModeResult,
  NotificationSettingsRow,
  ServerSystemStatus,
} from '../index.js';

describe('D-169 P1 contracts ratchet', () => {
  describe('MCP_RESERVED_RPC_PREFIXES', () => {
    it("reserves the `system.` namespace for local-UI / local-bridge only", () => {
      expect((MCP_RESERVED_RPC_PREFIXES as readonly string[])).toContain(
        'system.',
      );
    });

    it("keeps `notifications.` reserved (D-163 invariant carried forward)", () => {
      expect((MCP_RESERVED_RPC_PREFIXES as readonly string[])).toContain(
        'notifications.',
      );
    });

    it('isReservedLocalRpc flags every D-169 P1 method', () => {
      expect(isReservedLocalRpc('system.status')).toBe(true);
      expect(isReservedLocalRpc('notifications.describe_bridges')).toBe(true);
      expect(isReservedLocalRpc('notifications.set_bridge_mode')).toBe(true);
    });
  });

  describe('SERVER_RPC_METHOD_SET', () => {
    it('includes system.status', () => {
      expect(SERVER_RPC_METHOD_SET.has('system.status')).toBe(true);
    });

    it('includes notifications.describe_bridges', () => {
      expect(SERVER_RPC_METHOD_SET.has('notifications.describe_bridges')).toBe(
        true,
      );
    });

    it('includes notifications.set_bridge_mode', () => {
      expect(SERVER_RPC_METHOD_SET.has('notifications.set_bridge_mode')).toBe(
        true,
      );
    });
  });

  describe('NotificationBridgeModeRow', () => {
    it('carries notification + approval boolean fields', () => {
      const row: NotificationBridgeModeRow = {
        notification: false,
        approval: false,
      };
      expect(row.notification).toBe(false);
      expect(row.approval).toBe(false);
      expectTypeOf<NotificationBridgeModeRow['notification']>().toEqualTypeOf<boolean>();
      expectTypeOf<NotificationBridgeModeRow['approval']>().toEqualTypeOf<boolean>();
    });
  });

  describe('NotificationBridgeRow', () => {
    it('carries client_token_id, label, modes, optional added_at, connected', () => {
      const row: NotificationBridgeRow = {
        client_token_id: 'ct-1',
        label: 'Bridge1 Chrome on macOS',
        modes: { notification: false, approval: true },
        added_at: 1_700_000_000,
        connected: true,
      };
      expect(row.client_token_id).toBe('ct-1');
      expect(row.modes.approval).toBe(true);
      expect(row.added_at).toBe(1_700_000_000);
    });

    it('accepts a row without added_at (legacy / pre-D-156 paired rows)', () => {
      const row: NotificationBridgeRow = {
        client_token_id: 'ct-2',
        label: 'Bridge2 Edge on Windows',
        modes: { notification: true, approval: false },
        connected: false,
      };
      expect(row.added_at).toBeUndefined();
      expect(row.connected).toBe(false);
    });
  });

  describe('NotificationSetBridgeModeResult', () => {
    it('ok: true carries the new settings', () => {
      const result: NotificationSetBridgeModeResult = {
        ok: true,
        settings: {
          ui: true,
          bridge: false,
          slack: { notification: false, approval: false, messenger: false },
          telegram: { notification: false, approval: false, messenger: false },
          whatsapp: { notification: false, approval: false, messenger: false },
          discord: { notification: false, approval: false, messenger: false },
          teams: { notification: false, approval: false, messenger: false },
          email: { notification: false, approval: false, messenger: false },
          bridges: { 'ct-1': { notification: true, approval: false } },
        },
      };
      expect(result.ok).toBe(true);
    });

    it('ok: false carries bridge_unknown reason + bridge_id', () => {
      const result: NotificationSetBridgeModeResult = {
        ok: false,
        reason: 'bridge_unknown',
        bridge_id: 'ct-stale',
      };
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reason).toBe('bridge_unknown');
        expect(result.bridge_id).toBe('ct-stale');
      }
    });
  });

  describe('NotificationSettingsRow.bridges', () => {
    it('is an optional Record<string, NotificationBridgeModeRow>', () => {
      // Without bridges (legacy row shape) — must still type-check.
      const legacy: NotificationSettingsRow = {
        ui: true,
        bridge: false,
        slack: { notification: false, approval: false, messenger: false },
        telegram: { notification: false, approval: false, messenger: false },
        whatsapp: { notification: false, approval: false, messenger: false },
        discord: { notification: false, approval: false, messenger: false },
        teams: { notification: false, approval: false, messenger: false },
        email: { notification: false, approval: false, messenger: false },
      };
      expect(legacy.bridges).toBeUndefined();

      // With bridges — keys are client_token_ids.
      const populated: NotificationSettingsRow = {
        ui: true,
        bridge: true,
        slack: { notification: false, approval: false, messenger: false },
        telegram: { notification: false, approval: false, messenger: false },
        whatsapp: { notification: false, approval: false, messenger: false },
        discord: { notification: false, approval: false, messenger: false },
        teams: { notification: false, approval: false, messenger: false },
        email: { notification: false, approval: false, messenger: false },
        bridges: {
          'ct-1': { notification: true, approval: false },
          'ct-2': { notification: false, approval: true },
        },
      };
      expect(populated.bridges).toBeDefined();
      expect(Object.keys(populated.bridges ?? {})).toEqual(['ct-1', 'ct-2']);
    });
  });

  describe('ServerSystemStatus', () => {
    it('is the dashboard-shared baseline shape (spec § N.5 #1)', () => {
      const status: ServerSystemStatus = {
        name: 'home-server',
        version: '0.1.0',
        uptime_seconds: 120,
        paired_client_count: 3,
        paired_client_connected: 1,
        ws_state: 'serving',
        last_sync_at: 1_700_000_000_000,
        executions_last_hour: 0,
        executions_last_24h: 5,
        pending_asks: 0,
        ask_load: {
          window_ms: 604_800_000,
          raised: 4,
          answered_sample: 3,
          median_answer_ms: 120_000,
          load: 0.0008,
        },
        schedule_queue_depth: 2,
        recent_error_count: null,
        keyfile_sealing: 'machine',
        snapshot_at: 1_700_000_001_000,
      };
      expect(status.ws_state).toBe('serving');
      expect(status.recent_error_count).toBeNull();
    });

    it('ws_state is the closed `serving | idle | offline` union', () => {
      expectTypeOf<ServerSystemStatus['ws_state']>().toEqualTypeOf<
        'serving' | 'idle' | 'offline'
      >();
    });

    it('null counters surface the not-wired path (no faked zeros)', () => {
      const dbless: ServerSystemStatus = {
        name: 'dbless',
        version: 'unknown',
        uptime_seconds: 0,
        paired_client_count: 0,
        paired_client_connected: 0,
        ws_state: 'offline',
        last_sync_at: null,
        executions_last_hour: null,
        executions_last_24h: null,
        pending_asks: null,
        ask_load: null,
        schedule_queue_depth: null,
        recent_error_count: null,
        keyfile_sealing: null,
        snapshot_at: 0,
      };
      expect(dbless.executions_last_hour).toBeNull();
      expect(dbless.pending_asks).toBeNull();
    });

    /** D-212 §7.10 — `keyfile_sealing` is REQUIRED, not optional, and that is
     *  the point of it. §7.10 replaced the retracted §7.9 enrollment refusal
     *  with a visibility floor: an operator may run an unsealed keyfile, but
     *  not without knowing. An optional field lets a producer omit the posture
     *  and a renderer skip it, neither having decided anything — so the type
     *  forces every construction site to state one.
     *
     *  ⛔ `'none'` (known-UNSEALED: the key that opens the realm sits readable
     *  beside it) must never be collapsed into `null` (not wired). They are the
     *  same width on screen and opposite in meaning. */
    it('keyfile_sealing is required, and `none` is distinct from `null`', () => {
      expectTypeOf<ServerSystemStatus['keyfile_sealing']>().toEqualTypeOf<
        'machine' | 'passphrase' | 'none' | null
      >();
      // Required: omitting it is a type error, so a producer cannot stay silent.
      // @ts-expect-error — keyfile_sealing is mandatory on ServerSystemStatus
      const silent: ServerSystemStatus = {
        name: 'x', version: 'x', uptime_seconds: 0,
        paired_client_count: 0, paired_client_connected: 0,
        ws_state: 'offline', last_sync_at: null,
        executions_last_hour: null, executions_last_24h: null,
        pending_asks: null, schedule_queue_depth: null,
        recent_error_count: null, snapshot_at: 0,
      };
      void silent;
    });
  });
});
