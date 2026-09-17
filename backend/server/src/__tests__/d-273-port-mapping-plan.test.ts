/** D-273 P1 — the reconcile rules, exhaustively.
 *
 *  ⚠ Every case here is reachable in ordinary use. The DHCP one is not a corner:
 *  a lease renewal across a server restart is the single most likely way for a
 *  recorded mapping to stop being the one we want. */

import { describe, expect, it } from 'vitest';
import {
  applyPortMappingPlan,
  planPortMapping,
  renewalDelayMs,
  type DesiredPortMapping,
  type PortMappingRecord,
} from '../network/port-mapping-plan.js';

const RECORD: PortMappingRecord = {
  gateway: '192.168.1.1',
  protocol: 'tcp',
  internalPort: 443,
  internalIp: '192.168.1.42',
  externalPort: 443,
  createdAt: 1_700_000_000_000,
  lifetimeSeconds: 3600,
};

const DESIRED: DesiredPortMapping = {
  enabled: true,
  gateway: '192.168.1.1',
  protocol: 'tcp',
  internalPort: 443,
  internalIp: '192.168.1.42',
  externalPort: 443,
};

describe('D-273 — reconcile on start', () => {
  it('nothing recorded ⇒ just map', () => {
    expect(planPortMapping(null, DESIRED)).toEqual({
      release: null, releaseReachable: true, map: true, reason: 'no_record',
    });
  });

  it('🔑 unchanged ⇒ RE-ASSERT, which is how a restart continues without a gap', () => {
    // Refresh and create are the same operation, so "continue on the expiry"
    // needs no special case — it falls out of the record still matching.
    expect(planPortMapping(RECORD, DESIRED)).toEqual({
      release: null, releaseReachable: true, map: true, reason: 'unchanged',
    });
  });

  it('⛔⛔ a DHCP-moved internal IP ⇒ release then map, NOT a blind refresh', () => {
    // The mapping encodes the OLD address. Refreshing it would point the router
    // at a different machine on the LAN while reporting a healthy forward — the
    // exact failure that makes `internalIp` part of the record's identity.
    const plan = planPortMapping(RECORD, { ...DESIRED, internalIp: '192.168.1.77' });
    expect(plan).toEqual({
      release: RECORD, releaseReachable: true, map: true, reason: 'params_changed',
    });
  });

  it.each([
    ['public port moved', { externalPort: 8446 }],
    ['internal port moved', { internalPort: 8443 }],
    ['protocol changed', { protocol: 'udp' as const }],
  ])('⚠ %s ⇒ release then map', (_label, patch) => {
    expect(planPortMapping(RECORD, { ...DESIRED, ...patch })).toMatchObject({
      release: RECORD, map: true, reason: 'params_changed',
    });
  });

  it('⛔⛔ a DIFFERENT GATEWAY ⇒ map here, and do NOT try to release there', () => {
    // The laptop moved networks. The old mapping is on a router we are no longer
    // behind: there is nothing to send and nothing to wait for. ⚠ It is not
    // leaked into the void either — it expires on its own gateway, which is why
    // D-273 leans on the lease instead of an orderly teardown.
    expect(planPortMapping(RECORD, { ...DESIRED, gateway: '10.0.0.1' })).toEqual({
      release: RECORD, releaseReachable: false, map: true, reason: 'gateway_changed',
    });
  });
});

describe('D-273 — the toggle', () => {
  it('disabled with a record ⇒ take it down, map nothing', () => {
    expect(planPortMapping(RECORD, { ...DESIRED, enabled: false })).toEqual({
      release: RECORD, releaseReachable: true, map: false, reason: 'disabled',
    });
  });

  it('⚠ disabled with a record on ANOTHER gateway ⇒ still nothing to send', () => {
    expect(planPortMapping(
      RECORD, { ...DESIRED, enabled: false, gateway: '10.0.0.1' },
    )).toMatchObject({ release: RECORD, releaseReachable: false, map: false });
  });

  it('disabled with nothing recorded ⇒ idle', () => {
    expect(planPortMapping(null, { ...DESIRED, enabled: false })).toEqual({
      release: null, releaseReachable: true, map: false, reason: 'idle',
    });
  });

  it('⛔ NO PLAN EVER MAPS BEFORE IT RELEASES', () => {
    // The order is a safety property: if the new request fails, "no mapping" is
    // safe and visible. Mapping first would, on the same failure, leave a
    // pinhole aimed at a port we no longer serve. The plan cannot express the
    // wrong order — this pins that the shape stays that way.
    const plans = [
      planPortMapping(null, DESIRED),
      planPortMapping(RECORD, DESIRED),
      planPortMapping(RECORD, { ...DESIRED, externalPort: 8446 }),
      planPortMapping(RECORD, { ...DESIRED, enabled: false }),
    ];
    for (const plan of plans) {
      expect(Object.keys(plan).sort())
        .toEqual(['map', 'reason', 'release', 'releaseReachable']);
    }
  });
});

describe('D-273 — renewal timing', () => {
  it('⛔ HALF the GRANTED lifetime, so one lost renewal does not cost the mapping', () => {
    expect(renewalDelayMs(3600)).toBe(1_800_000);
    expect(renewalDelayMs(600)).toBe(300_000);
  });

  it('⚠ a shortened grant shortens the clock — timed off granted, never requested', () => {
    // Asked 7200, granted 600. A clock set from the request would drift past
    // expiry while every log line said it was renewed.
    expect(renewalDelayMs(600)).toBeLessThan(renewalDelayMs(7200));
  });

  it('⚠ never zero, so a degenerate grant cannot become a hot loop', () => {
    expect(renewalDelayMs(1)).toBe(1000);
    expect(renewalDelayMs(0)).toBe(1000);
  });
});

describe('D-273 — applying a plan', () => {
  const mkStore = () => {
    let record: PortMappingRecord | null = null;
    return {
      get: () => record,
      set: (r: PortMappingRecord) => { record = r; },
      clear: () => { record = null; },
      peek: () => record,
    };
  };
  const okActuator = (over: Partial<{ externalPort: number; lifetimeSeconds: number }> = {}) => ({
    calls: [] as string[],
    async map() { this.calls.push('map'); return { externalPort: 443, lifetimeSeconds: 3600, ...over }; },
    async unmap() { this.calls.push('unmap'); },
  });

  const run = async (
    plan: ReturnType<typeof planPortMapping>,
    actuator: ReturnType<typeof okActuator>,
    store = mkStore(),
    desired = DESIRED,
  ) => ({
    result: await applyPortMappingPlan({
      plan, desired, store, actuator, lifetimeSeconds: 3600, now: () => 1_700_000_000_000,
    }),
    store,
  });

  it('⛔ RELEASES BEFORE IT MAPS', async () => {
    const actuator = okActuator();
    await run(planPortMapping(RECORD, { ...DESIRED, externalPort: 8446 }), actuator);
    expect(actuator.calls).toEqual(['unmap', 'map']);
  });

  it('⛔⛔ records what the GATEWAY GAVE, not what we asked for', async () => {
    // § 3.3 lets the gateway assign a different external port and a shorter
    // lease. Recording our request would make the next reconcile compare against
    // a mapping that never existed — and time renewal off a lifetime nobody
    // granted.
    const { store } = await run(
      planPortMapping(null, DESIRED),
      okActuator({ externalPort: 9443, lifetimeSeconds: 600 }),
    );
    expect(store.peek()).toMatchObject({ externalPort: 9443, lifetimeSeconds: 600 });
  });

  it('⛔ a FAILED RELEASE does not stop the remap', async () => {
    // The mapping we could not take down expires on its own. Refusing to
    // continue leaves the owner with neither the old one working nor a new one.
    const actuator = {
      calls: [] as string[],
      async map() { this.calls.push('map'); return { externalPort: 443, lifetimeSeconds: 3600 }; },
      async unmap() { this.calls.push('unmap'); throw new Error('gateway said no'); },
    };
    const { result } = await run(
      planPortMapping(RECORD, { ...DESIRED, externalPort: 8446 }), actuator,
    );
    expect(actuator.calls).toEqual(['unmap', 'map']);
    expect(result.outcome).toBe('mapped');
  });

  it('⛔ a gateway-changed plan sends NOTHING to the old router', async () => {
    const actuator = okActuator();
    await run(planPortMapping(RECORD, { ...DESIRED, gateway: '10.0.0.1' }), actuator);
    expect(actuator.calls).toEqual(['map']);
  });

  it('⚠ the abandoned record is CLEARED, so the next boot does not chase it', async () => {
    const store = mkStore();
    store.set(RECORD);
    await run(
      planPortMapping(RECORD, { ...DESIRED, gateway: '10.0.0.1' }),
      okActuator(), store, { ...DESIRED, gateway: '10.0.0.1' },
    );
    expect(store.peek()?.gateway).toBe('10.0.0.1');
  });

  it('⛔ a refusal is an ANSWER, not a crash — and reads differently from silence', async () => {
    // "Your router has this switched off" is something the owner can go and
    // change; "the gateway never answered" is not. Collapsing them would tell
    // half of readers to do something impossible.
    const refused = Object.assign(new Error('nat-pmp: not_authorized'), { code: 'not_authorized' });
    const silent = new Error('nat-pmp: timeout');
    const mk = (err: Error) => ({
      calls: [] as string[],
      async map(): Promise<{ externalPort: number; lifetimeSeconds: number }> { throw err; },
      async unmap() { /* unused */ },
    });
    const a = await run(planPortMapping(null, DESIRED), mk(refused) as never);
    const b = await run(planPortMapping(null, DESIRED), mk(silent) as never);
    expect(a.result.outcome).toBe('unavailable');
    expect(b.result.outcome).toBe('failed');
    // ⛔ And neither leaves a record claiming a mapping exists.
    expect(a.store.peek()).toBeNull();
    expect(b.store.peek()).toBeNull();
  });

  it('disabled ⇒ released, and the record is gone', async () => {
    const store = mkStore();
    store.set(RECORD);
    const actuator = okActuator();
    const { result } = await run(
      planPortMapping(RECORD, { ...DESIRED, enabled: false }), actuator, store,
    );
    expect(actuator.calls).toEqual(['unmap']);
    expect(result.outcome).toBe('released');
    expect(store.peek()).toBeNull();
  });
});
