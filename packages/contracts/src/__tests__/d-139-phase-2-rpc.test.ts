/** D-139 P2 — Connection-page UX rpc surfaces.
 *
 *  Substrate-only: confirms the two new rpc methods land in
 *  `SERVER_RPC_METHODS` + the contract types compile correctly. */

import { describe, expect, it } from 'vitest';
import {
  RATE_CONTROL_STATE_VALUES,
  isRateControlStateValue,
  SERVER_RPC_METHODS,
  SERVER_RPC_METHOD_SET,
} from '../index.js';
import type {
  EngagementHealthRow,
  EngagementHealthResponse,
  ReprobeEngagementCapabilitiesResponse,
} from '../index.js';

describe('D-139 P2 — collection.connection.engagementHealth + reprobeEngagementCapabilities rpc', () => {
  const expected = [
    'collection.connection.engagementHealth',
    'collection.connection.reprobeEngagementCapabilities',
  ] as const;

  it.each(expected)('registers %s in SERVER_RPC_METHODS', (method) => {
    expect((SERVER_RPC_METHODS as readonly string[]).includes(method)).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has(method)).toBe(true);
  });

  it('preserves the prior connection-rpc methods (P2 is purely additive)', () => {
    // Ratchet against accidental SERVER_RPC_METHODS rewrite that loses
    // prior rows.
    expect(SERVER_RPC_METHOD_SET.has('collection.connection.list')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('collection.connection.enroll')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('collection.connection.update')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('collection.connection.delete')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('collection.connection.probe')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('collection.connection.completeVendorOAuth')).toBe(
      true,
    );
  });
});

describe('D-139 P2 — RateControlStateValue closed list', () => {
  it('matches engagement-rate-control-store.ts:RateControlState verbatim', () => {
    // The contract re-declaration must stay in lockstep with the
    // server-side closed list. Adding a state on the server requires
    // adding it here too — by construction (the server reads the
    // contract type when populating the rpc response).
    expect(RATE_CONTROL_STATE_VALUES).toEqual([
      'normal',
      'degraded_30m',
      'degraded_1h',
      'suspended',
    ]);
  });

  it('isRateControlStateValue accepts every closed-list value', () => {
    for (const v of RATE_CONTROL_STATE_VALUES) {
      expect(isRateControlStateValue(v)).toBe(true);
    }
  });

  it('isRateControlStateValue rejects unknown / non-string', () => {
    expect(isRateControlStateValue('emergency')).toBe(false);
    expect(isRateControlStateValue('')).toBe(false);
    expect(isRateControlStateValue(null)).toBe(false);
    expect(isRateControlStateValue(undefined)).toBe(false);
    expect(isRateControlStateValue(0)).toBe(false);
    expect(isRateControlStateValue({})).toBe(false);
  });
});

describe('D-139 P2 — health response shape', () => {
  it('EngagementHealthResponse carries vendor + rows + budget bookkeeping', () => {
    const resp: EngagementHealthResponse = {
      vendor: 'hubspot',
      rows: [],
      daily_budget: 250_000,
      bucket_started_at: 1_700_000_000_000,
      relationships: [],
    };
    // Type-level assertions; runtime check is just structural.
    expect(resp.vendor).toBe('hubspot');
    expect(resp.rows).toHaveLength(0);
    expect(resp.daily_budget).toBe(250_000);
    expect(resp.bucket_started_at).toBe(1_700_000_000_000);
  });

  it('EngagementHealthRow optional capability field is Salesforce-only', () => {
    const hubspotRow: EngagementHealthRow = {
      vendor: 'hubspot',
      entity: 'email',
      last_pulled_at: null,
      last_error: null,
      pages_fetched_today: 0,
      api_calls_consumed_today: 0,
      budget_utilization_pct: 0,
      rate_control_state: 'normal',
    };
    expect(hubspotRow.capability).toBeUndefined();

    const salesforceRow: EngagementHealthRow = {
      vendor: 'salesforce',
      entity: 'task',
      last_pulled_at: 1_700_000_000_000,
      last_error: null,
      pages_fetched_today: 4,
      api_calls_consumed_today: 12,
      budget_utilization_pct: 0.0024,
      rate_control_state: 'normal',
      capability: {
        connection_id: 'conn_42',
        vendor: 'salesforce',
        entity: 'task',
        available: true,
        cdc_supported: true,
        push_topic_supported: true,
        reconciler_only: false,
        association_rescan_required: false,
        last_probed_at: 1_700_000_000_000,
      },
    };
    expect(salesforceRow.capability?.entity).toBe('task');
  });
});

describe('D-139 P2 — reprobe response shape', () => {
  it('ReprobeEngagementCapabilitiesResponse carries dual-schema pick + pushtopic outcome', () => {
    const resp: ReprobeEngagementCapabilitiesResponse = {
      rows: [],
      reprobed_at: 1_700_000_000_000,
      winning_call_entity: 'voice_call',
      call_entity_changed: true,
      pushtopic_creation: [
        { entity: 'task', outcome: 'preserved' },
        { entity: 'event', outcome: 'created' },
        { entity: 'voice_call', outcome: 'create_failed', error: 'permission denied' },
      ],
    };
    expect(resp.winning_call_entity).toBe('voice_call');
    expect(resp.call_entity_changed).toBe(true);
    expect(resp.pushtopic_creation).toHaveLength(3);
  });
});
