/** D-184 — VendorRateGate: the shared per-(connection, vendor) skip-if-busy
 *  concurrency flag + daily-budget gate for all vendor reconcilers. */

import { describe, expect, it, vi } from 'vitest';

import type { EngagementRateControlStore } from '../../../storage/engagement-rate-control-store.js';
import { createVendorRateGate, type RateGateLease } from '../vendor-rate-gate.js';

/** Minimal store mock — the gate reads only `readUsage().rate_control_state`
 *  and calls `recordUsage` / `recordPages`. */
const mockStore = (
  state: 'normal' | 'suspended' = 'normal',
): EngagementRateControlStore => ({
  readUsage: vi.fn(() => ({ rate_control_state: state })),
  recordUsage: vi.fn(() => ({})),
  recordPages: vi.fn(() => ({})),
} as unknown as EngagementRateControlStore);

const acq = (gate: ReturnType<typeof createVendorRateGate>, connection_id: string, now = 1, vendor: 'hubspot' | 'salesforce' = 'hubspot') =>
  gate.acquire({ connection_id, vendor, now });

describe('VendorRateGate — concurrency (skip-if-busy)', () => {
  it('returns "busy" while a pull is in flight for the SAME (connection, vendor)', () => {
    const gate = createVendorRateGate(mockStore('normal'));
    const a = acq(gate, 'c1');
    expect(a).not.toBe('suspended');
    expect(a).not.toBe('busy');
    // Second acquire for the same key while A holds → busy (skip, don't queue).
    expect(acq(gate, 'c1')).toBe('busy');
    // Releasing A frees the slot — a subsequent acquire proceeds.
    (a as RateGateLease).release();
    const b = acq(gate, 'c1');
    expect(b).not.toBe('busy');
    expect(b).not.toBe('suspended');
    (b as RateGateLease).release();
  });

  it('does NOT report busy across different (connection, vendor) keys', () => {
    const gate = createVendorRateGate(mockStore('normal'));
    const a = acq(gate, 'c1', 1, 'hubspot');
    const b = acq(gate, 'c2', 1, 'hubspot'); // different connection
    const c = acq(gate, 'c1', 1, 'salesforce'); // different vendor
    expect(a).not.toBe('busy');
    expect(b).not.toBe('busy');
    expect(c).not.toBe('busy');
  });

  it('release is idempotent', () => {
    const gate = createVendorRateGate(mockStore('normal'));
    const a = acq(gate, 'c1') as RateGateLease;
    a.release();
    a.release(); // no throw, no double-free effect
    // slot is free again
    expect(acq(gate, 'c1')).not.toBe('busy');
  });
});

describe('VendorRateGate — daily budget', () => {
  it('returns "suspended" (without claiming the slot) when the budget is exhausted', () => {
    const gate = createVendorRateGate(mockStore('suspended'));
    expect(acq(gate, 'c1')).toBe('suspended');
    // The slot was never claimed — a subsequent acquire still resolves (no leak).
    expect(acq(gate, 'c1')).toBe('suspended');
  });

  it('checks busy BEFORE budget — an in-flight key reports busy even if suspended', () => {
    // Start normal (claim the slot), then flip the store to suspended: the
    // second acquire for the held key short-circuits to busy without a budget read.
    const store = mockStore('normal');
    const gate = createVendorRateGate(store);
    const a = acq(gate, 'c1') as RateGateLease;
    (store.readUsage as ReturnType<typeof vi.fn>).mockReturnValue({ rate_control_state: 'suspended' });
    expect(acq(gate, 'c1')).toBe('busy');
    a.release();
  });

  it('lease.record bumps recordUsage (per-connection) + recordPages (per-entity)', () => {
    const store = mockStore('normal');
    const gate = createVendorRateGate(store);
    const a = acq(gate, 'c1', 5) as RateGateLease;
    a.record({ api_calls: 3, entity: 'email', pages: 3, now: 6 });
    expect(store.recordUsage).toHaveBeenCalledWith({ connection_id: 'c1', vendor: 'hubspot', n: 3, now: 6 });
    expect(store.recordPages).toHaveBeenCalledWith({ connection_id: 'c1', vendor: 'hubspot', entity: 'email', n: 3, now: 6 });
    a.release();
  });

  it('record is a no-op for zero counts', () => {
    const store = mockStore('normal');
    const gate = createVendorRateGate(store);
    const a = acq(gate, 'c1') as RateGateLease;
    a.record({ api_calls: 0, entity: 'email', pages: 0, now: 2 });
    expect(store.recordUsage).not.toHaveBeenCalled();
    expect(store.recordPages).not.toHaveBeenCalled();
    a.release();
  });
});
