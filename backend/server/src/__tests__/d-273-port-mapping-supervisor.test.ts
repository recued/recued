/** D-273 P1 — the supervisor: boot, renew, react, take down. */

import { describe, expect, it, vi } from 'vitest';
import {
  composePortMappingDesire,
  createPortMappingSupervisor,
  PORT_MAPPING_IDLE_RECHECK_MS,
  PORT_MAPPING_RETRY_DELAY_MS,
  type PortMappingDesire,
} from '../network/port-mapping-supervisor.js';
import type { PortMappingRecord } from '../network/port-mapping-plan.js';

const DESIRED = {
  enabled: true,
  gateway: '192.168.1.1',
  protocol: 'tcp' as const,
  internalPort: 443,
  internalIp: '192.168.1.42',
  externalPort: 443,
};

/** A hand-run clock: timers are collected, never fired by wall time. */
const mkTimers = () => {
  const pending: { id: number; fn: () => void; ms: number }[] = [];
  let next = 1;
  return {
    pending,
    // ⚠ The handle is `unknown` on both sides, matching the seam. A narrower
    // parameter here is not assignable to it under `strictFunctionTypes` — and
    // that mismatch is invisible to vitest, which is why `typecheck:tests` is
    // the gate that caught it.
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = next++;
      pending.push({ id, fn, ms });
      return id;
    },
    clearTimer: (h: unknown) => {
      const i = pending.findIndex((p) => p.id === h);
      if (i >= 0) pending.splice(i, 1);
    },
    fireLast: async () => {
      const last = pending.pop();
      last?.fn();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
};

const mkStore = (initial: PortMappingRecord | null = null) => {
  let record = initial;
  return {
    get: () => record,
    set: (r: PortMappingRecord) => { record = r; },
    clear: () => { record = null; },
    peek: () => record,
  };
};

const mkActuator = (over: Partial<{ externalPort: number; lifetimeSeconds: number }> = {}) => {
  const calls: string[] = [];
  return {
    calls,
    async map() { calls.push('map'); return { externalPort: 443, lifetimeSeconds: 600, ...over }; },
    async unmap() { calls.push('unmap'); },
  };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('D-273 — the supervisor', () => {
  it('maps at start and schedules renewal at HALF the granted lifetime', async () => {
    const timers = mkTimers();
    const actuator = mkActuator({ lifetimeSeconds: 600 });
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => actuator,
      ...timers,
    });
    sup.start();
    await flush();
    expect(actuator.calls).toEqual(['map']);
    expect(timers.pending[0]?.ms).toBe(300_000);
  });

  it('🔑 renewal is just ANOTHER RECONCILE — it re-asserts the same mapping', async () => {
    // Re-asserting IS how NAT-PMP refreshes, so there is no separate renew path
    // to get wrong. The second `map` is the renewal.
    const timers = mkTimers();
    const actuator = mkActuator();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => actuator,
      ...timers,
    });
    sup.start();
    await flush();
    await timers.fireLast();
    expect(actuator.calls).toEqual(['map', 'map']);
  });

  it('⛔ READS THE INTENT FRESH every time, so a toggle-off actually lands', async () => {
    // A cached desire is how a supervisor keeps renewing a mapping the owner
    // switched off — the renewal would keep succeeding and the copy would keep
    // saying it was on.
    const timers = mkTimers();
    const actuator = mkActuator();
    const store = mkStore();
    let enabled = true;
    const sup = createPortMappingSupervisor({
      store,
      readDesire: (): PortMappingDesire => ({ kind: 'ready', desired: { ...DESIRED, enabled } }),
      makeActuator: () => actuator,
      ...timers,
    });
    sup.start();
    await flush();
    expect(store.peek()).not.toBeNull();

    enabled = false;
    await sup.reconcile();
    await flush();
    expect(actuator.calls).toEqual(['map', 'unmap']);
    expect(store.peek()).toBeNull();
  });

  it('⚠ a released mapping keeps NO LEASE TIMER — but does re-check the router', async () => {
    // ⚠⚠ THIS TEST USED TO ASSERT `pending` WAS EMPTY, and it was correct about
    // its subject and wrong about the conclusion: there is indeed nothing to
    // KEEP ALIVE, which is not the same as nothing to LOOK AT. While it held,
    // an owner who enabled UPnP in their router saw the stale answer forever
    // (audit P2-7) — so the assertion defended the staleness.
    //
    // 🔑 The distinction the timer now carries: a lease is a DEADLINE, and the
    // idle cadence is a CACHE EXPIRY over a fact that lives in the router.
    const timers = mkTimers();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: { ...DESIRED, enabled: false } }),
      makeActuator: () => mkActuator(),
      ...timers,
    });
    sup.start();
    await flush();
    expect(timers.pending).toHaveLength(1);
    expect(timers.pending[0]?.ms).toBe(PORT_MAPPING_IDLE_RECHECK_MS);
    expect(timers.pending[0]?.ms).not.toBe(300_000);
  });

  it('⛔ a failure retries on the RETRY cadence, not the renewal one', async () => {
    // There is no mapping to renew, and a briefly-busy gateway should not cost
    // the owner their away access until a full lease would have elapsed.
    const timers = mkTimers();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => ({
        async map(): Promise<{ externalPort: number; lifetimeSeconds: number }> {
          throw new Error('nat-pmp: timeout');
        },
        async unmap() { /* unused */ },
      }),
      ...timers,
    });
    sup.start();
    await flush();
    expect(timers.pending[0]?.ms).toBe(PORT_MAPPING_RETRY_DELAY_MS);
    expect(sup.status().last?.outcome).toBe('failed');
  });

  it('⛔⛔ A THROWN RECONCILE DOES NOT KILL RENEWAL', async () => {
    // Everything under this is best-effort network work. An unexpected throw
    // that stopped the timer would end renewal for the life of the process and
    // the mapping would lapse silently.
    const timers = mkTimers();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => { throw new Error('boom'); },
      makeActuator: () => mkActuator(),
      ...timers,
    });
    sup.start();
    await flush();
    expect(timers.pending[0]?.ms).toBe(PORT_MAPPING_RETRY_DELAY_MS);
  });

  it('⚠ unavailable attempts NOTHING and keeps the record', async () => {
    // A record we cannot act on is not one to forget: the mapping it describes
    // is still out there and expires by itself.
    const timers = mkTimers();
    const record: PortMappingRecord = {
      gateway: '192.168.1.1', protocol: 'tcp', internalPort: 443,
      internalIp: '192.168.1.42', externalPort: 443,
      createdAt: 1, lifetimeSeconds: 600,
    };
    const store = mkStore(record);
    const actuator = mkActuator();
    const sup = createPortMappingSupervisor({
      store,
      readDesire: () => ({ kind: 'unavailable', reason: 'no_gateway' }),
      makeActuator: () => actuator,
      ...timers,
    });
    sup.start();
    await flush();
    expect(actuator.calls).toEqual([]);
    expect(store.peek()).toEqual(record);
    expect(sup.status().unavailable).toBe('no_gateway');
  });

  it('⛔ a config change DURING a reconcile is queued, never dropped', async () => {
    // Coalescing into the in-flight run would answer with the OLD intent, so a
    // `public_port` edit landing mid-renewal would silently not take effect.
    const timers = mkTimers();
    let release: (() => void) | null = null;
    const calls: string[] = [];
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => ({
        async map() {
          calls.push('map');
          if (calls.length === 1) await new Promise<void>((r) => { release = r; });
          return { externalPort: 443, lifetimeSeconds: 600 };
        },
        async unmap() { calls.push('unmap'); },
      }),
      ...timers,
    });
    sup.start();
    await flush();
    expect(calls).toEqual(['map']);      // first run is parked mid-flight
    void sup.reconcile();                 // a change arrives while it runs
    void sup.reconcile();                 // ...and another
    await flush();
    expect(calls).toEqual(['map']);      // still only one in flight
    release!();
    await flush();
    // ⚠ EXACTLY ONE follow-up, not one per request — the queue is a flag, so a
    // burst of config writes cannot become a burst of gateway traffic.
    expect(calls).toEqual(['map', 'map']);
  });

  it('subscribes to config changes on start and unsubscribes on stop', async () => {
    const timers = mkTimers();
    const unsub = vi.fn();
    const onConfigChange = vi.fn(() => unsub);
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => mkActuator(),
      onConfigChange,
      ...timers,
    });
    sup.start();
    await flush();
    expect(onConfigChange).toHaveBeenCalledTimes(1);
    sup.stop();
    expect(unsub).toHaveBeenCalledTimes(1);
    // ⛔ And stop does NOT release — D-273: the mapping expires rather than being
    // taken down, because the process is not reliably alive at this point.
    expect(timers.pending).toHaveLength(0);
  });

  it('⚠ a gateway change builds a NEW actuator, never reuses the old one', async () => {
    // A client pinned at construction would send this network's requests to the
    // last network's router.
    const timers = mkTimers();
    const seen: string[] = [];
    let gateway = '192.168.1.1';
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: { ...DESIRED, gateway } }),
      makeActuator: (g) => { seen.push(g ?? '<none>'); return mkActuator(); },
      ...timers,
    });
    sup.start();
    await flush();
    gateway = '10.0.0.1';
    await sup.reconcile();
    await flush();
    expect(seen).toEqual(['192.168.1.1', '10.0.0.1']);
  });
});

describe('D-273 — composing the intent', () => {
  const base = {
    enabled: true, gateway: '192.168.1.1', lanAddress: '192.168.1.42', publicPort: 443,
  };

  it('maps the public port to this machine, same number both sides', () => {
    expect(composePortMappingDesire(base)).toEqual({
      kind: 'ready',
      desired: {
        enabled: true, gateway: '192.168.1.1', protocol: 'tcp',
        internalPort: 443, externalPort: 443, internalIp: '192.168.1.42',
      },
    });
  });

  it('⛔ NO GATEWAY ⇒ unavailable, not a failure to report to the owner', () => {
    // `readDefaultRouteGateway()` returns undefined on win32. NAT-PMP needs a
    // unicast target; there is nothing to try, and UPnP's multicast discovery
    // is what covers it later.
    expect(composePortMappingDesire({ ...base, gateway: undefined }))
      .toEqual({ kind: 'unavailable', reason: 'no_gateway' });
  });

  it('⛔⛔ a LOOPBACK lan address ⇒ unavailable, never a mapping to 127.0.0.1', () => {
    // Loopback is `resolveLanAddress`'s "no LAN interface found" answer. Asking
    // the router to forward the internet to this host's loopback is not an
    // awkward mapping, it is a meaningless one.
    for (const lanAddress of ['127.0.0.1', '127.0.1.1', '::1']) {
      expect(composePortMappingDesire({ ...base, lanAddress }))
        .toEqual({ kind: 'unavailable', reason: 'no_lan_address' });
    }
  });

  it('⚠ disabled is still READY — there may be a mapping to take down', () => {
    // "Unavailable" means we cannot act at all; "disabled" means act by
    // releasing. Collapsing them would strand a live mapping the moment the
    // owner switched the toggle off.
    expect(composePortMappingDesire({ ...base, enabled: false }))
      .toMatchObject({ kind: 'ready', desired: { enabled: false } });
  });

  it('follows the configured public port', () => {
    expect(composePortMappingDesire({ ...base, publicPort: 8446 }))
      .toMatchObject({ desired: { internalPort: 8446, externalPort: 8446 } });
  });
});

describe('D-273 P0 — detection through the supervisor', () => {
  const timers = () => mkTimers();

  it('🔑 detection ANSWERS EVEN WITH THE TOGGLE OFF', async () => {
    // The whole of P0's value: the router step can say "your router supports
    // this, switch it on" before anyone has opened anything. Detection asks for
    // an address; it never requests a mapping.
    const t = timers();
    const actuator = mkActuator();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: { ...DESIRED, enabled: false } }),
      makeActuator: () => actuator,
      detect: async () => ({ kind: 'enabled' as const, externalIp: '203.0.113.7' }),
      ...t,
    });
    sup.start();
    await flush();
    expect(sup.status().support).toMatchObject({ kind: 'enabled' });
    // ...and nothing was mapped.
    expect(actuator.calls).toEqual([]);
  });

  it('⛔ with no gateway, support is `unknown` — not a verdict about a router', async () => {
    const t = timers();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'unavailable', reason: 'no_gateway' }),
      makeActuator: () => mkActuator(),
      detect: async () => ({ kind: 'enabled' as const }),
      ...t,
    });
    sup.start();
    await flush();
    // ⚠ The injected `detect` is NOT consulted — there is no gateway to pass it.
    expect(sup.status().support).toMatchObject({ kind: 'unknown' });
  });

  it('⚠ no detector wired ⇒ support stays null, never a guess', async () => {
    const t = timers();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => mkActuator(),
      ...t,
    });
    sup.start();
    await flush();
    expect(sup.status().support).toBeNull();
  });

  it('⚠ detection is asked about the CURRENT gateway, on every reconcile', async () => {
    const t = timers();
    const asked: string[] = [];
    let gateway = '192.168.1.1';
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: { ...DESIRED, gateway } }),
      makeActuator: () => mkActuator(),
      detect: async (g) => { asked.push(g ?? '<none>'); return { kind: 'enabled' as const }; },
      ...t,
    });
    sup.start();
    await flush();
    gateway = '10.0.0.1';
    await sup.reconcile();
    await flush();
    expect(asked).toEqual(['192.168.1.1', '10.0.0.1']);
  });
});

// ──────────────────────────────────────────────────────────────────
// ⛔⛔ WHICH RECONCILE PATH RUNS — the composition question that was wrong.
//
// The supervisor ran the blind NAT-PMP plan for EVERY protocol, because the
// composition root handed it an actuator with only `map`/`unmap` and there was
// nothing to branch on. On an IGD router that is destructive, not merely
// limited: `AddPortMapping` overwrites (spec § 2.4.16).
//
// 🔑 THE DISCRIMINATOR IS A CAPABILITY PROBE, NOT A PROTOCOL NAME AND NOT THE
// PRESENCE OF A METHOD. The composed actuator always DEFINES `getMapping` — it
// cannot know at construction which protocol will answer — so branching on
// `typeof actuator.getMapping` would have taken the IGD path against NAT-PMP and
// thrown on every reconcile.
// ──────────────────────────────────────────────────────────────────
describe('D-273 — the supervisor picks the path by asking, not by assuming', () => {
  const askableActuator = () => {
    const calls: string[] = [];
    return {
      calls,
      async map() { calls.push('map'); return { externalPort: 443, lifetimeSeconds: 600 }; },
      async unmap() { calls.push('unmap'); },
      async getMapping() {
        calls.push('ask');
        // Something else already holds it — the case the blind path maps over.
        return {
          internalClient: '192.168.1.9', internalPort: 443,
          enabled: true, leaseSeconds: 0, description: 'owner',
        };
      },
    };
  };

  it('⛔⛔ ASKS FIRST when the gateway can be asked, and does not map over a stranger', async () => {
    const actuator = askableActuator();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => actuator,
      canEnumerate: async () => true,
      ...mkTimers(),
    });
    sup.start();
    await flush();
    expect(actuator.calls).toEqual(['ask']);
    // ⚠ `foreign_conflict`, NOT `conflict` — and the difference is the RECORD.
    // With an empty store we never mapped here, so whatever holds the port is
    // the owner's; `conflict` is reserved for "we mapped here and someone else
    // has it now". Both refuse to act; they say different things to the reader,
    // which is the entire reason the matrix has two axes.
    expect(sup.status().last?.outcome).toBe('foreign_conflict');
    expect(sup.status().last?.heldBy).toBe('192.168.1.9');
  });

  it('⚠ acts BLIND when it cannot be asked — which is all NAT-PMP can do', async () => {
    const actuator = askableActuator();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => actuator,
      canEnumerate: async () => false,
      ...mkTimers(),
    });
    sup.start();
    await flush();
    expect(actuator.calls).toEqual(['map']);
    expect(sup.status().last?.outcome).toBe('mapped');
  });

  it('⚠ a capability probe that THROWS reads as "cannot ask", never as "can"', async () => {
    // Failing open here would run the IGD path against a router that cannot
    // answer, and every reconcile would throw on the first lookup.
    const actuator = askableActuator();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => actuator,
      canEnumerate: async () => { throw new Error('gateway went away'); },
      ...mkTimers(),
    });
    sup.start();
    await flush();
    expect(actuator.calls).toEqual(['map']);
  });

  it('⚠ omitted probe ⇒ blind, so an un-upgraded composition cannot silently claim safety', async () => {
    const actuator = askableActuator();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => actuator,
      ...mkTimers(),
    });
    sup.start();
    await flush();
    expect(actuator.calls).toEqual(['map']);
  });
});

// ──────────────────────────────────────────────────────────────────
// Audit P2-6 — a host with no readable default route is not a host with no
// router. SSDP is multicast; only NAT-PMP needs a unicast target.
// ──────────────────────────────────────────────────────────────────
describe('D-273 audit P2-6 — no default route still reaches an IGD', () => {
  it('⛔⛔ win32 (gateway ALWAYS undefined) is not `no_gateway` when SSDP is wired', () => {
    // `readDefaultRouteGateway()` returns undefined on win32 by design. The
    // desire short-circuited on that BEFORE discovery, so neither detection nor
    // mapping reached the IGD implementation on Windows for the whole of P2/P3 —
    // while the comment right there said UPnP "is what covers this".
    const desire = composePortMappingDesire({
      enabled: true,
      gateway: undefined,
      lanAddress: '192.168.1.42',
      publicPort: 443,
      discoveryAvailable: true,
    });
    expect(desire.kind).toBe('ready');
  });

  it('⚠ and WITHOUT discovery it is still honestly `no_gateway`', () => {
    // Omitted ⇒ false: a composition that wired no SSDP transport has nothing to
    // try, and saying otherwise would report a capability nobody has.
    const desire = composePortMappingDesire({
      enabled: true,
      gateway: undefined,
      lanAddress: '192.168.1.42',
      publicPort: 443,
    });
    expect(desire).toEqual({ kind: 'unavailable', reason: 'no_gateway' });
  });

  it('⚠ a loopback-only host is STILL unavailable — that gate is unrelated', () => {
    expect(composePortMappingDesire({
      enabled: true,
      gateway: undefined,
      lanAddress: '127.0.0.1',
      publicPort: 443,
      discoveryAvailable: true,
    })).toEqual({ kind: 'unavailable', reason: 'no_lan_address' });
  });
});

// ──────────────────────────────────────────────────────────────────
// Audit P2-7 — an off installation must still notice the router changing.
// ──────────────────────────────────────────────────────────────────
describe('D-273 audit P2-7 — idle re-detects on a slow clock', () => {
  it('⛔⛔ schedules a RE-CHECK when idle, instead of nothing at all', async () => {
    // The old behaviour scheduled no timer on idle, so an owner who switched
    // UPnP ON IN THEIR ROUTER kept seeing `disabled` forever: the only thing
    // that would refresh it was a Recued config write, which is not the thing
    // they changed.
    const timers = mkTimers();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: { ...DESIRED, enabled: false } }),
      makeActuator: () => mkActuator(),
      ...timers,
    });
    sup.start();
    await flush();
    expect(sup.status().last?.outcome).toBe('idle');
    expect(timers.pending[0]?.ms).toBe(PORT_MAPPING_IDLE_RECHECK_MS);
  });

  it('⚠ and that re-check ASKS THE ROUTER AGAIN, which is the whole point', async () => {
    const timers = mkTimers();
    const asked: number[] = [];
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: { ...DESIRED, enabled: false } }),
      makeActuator: () => mkActuator(),
      detect: async () => { asked.push(1); return { kind: 'disabled' as const }; },
      ...timers,
    });
    sup.start();
    await flush();
    expect(asked).toHaveLength(1);
    timers.pending[0]?.fn();
    await flush();
    expect(asked).toHaveLength(2);
  });

  it('⚠ a MAPPED install times off the lease, not this slower clock', async () => {
    // The re-check must not shorten renewal — a lease is a deadline, and the
    // idle cadence is a cache expiry. Different jobs, different clocks.
    const timers = mkTimers();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => mkActuator(),
      ...timers,
    });
    sup.start();
    await flush();
    expect(timers.pending[0]?.ms).toBe(300_000);
  });
});

// ──────────────────────────────────────────────────────────────────
// Audit P2-15 — a supervisor that is started must be stoppable, and stopped.
// ──────────────────────────────────────────────────────────────────
describe('D-273 audit P2-15 — teardown drains this supervisor', () => {
  it('⛔⛔ stop() cancels the timer AND the config subscription', async () => {
    // The composition root started it and never stopped it, so the renewal timer
    // and the runtime-config subscription outlived listener teardown: a
    // reconcile could be in flight — talking to a router, then writing its
    // record — while the database it writes to was closing underneath it.
    const timers = mkTimers();
    let unsubscribed = false;
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => mkActuator(),
      onConfigChange: () => () => { unsubscribed = true; },
      ...timers,
    });
    sup.start();
    await flush();
    expect(timers.pending.length).toBeGreaterThan(0);
    sup.stop();
    expect(unsubscribed).toBe(true);
    expect(timers.pending).toHaveLength(0);
  });

  it('⚠ and a config change AFTER stop starts nothing', async () => {
    // The subscription is the half most likely to be forgotten: a timer that
    // fires once more is noise, a live subscription is an open door.
    const timers = mkTimers();
    let fire: (() => void) | undefined;
    const actuator = mkActuator();
    const sup = createPortMappingSupervisor({
      store: mkStore(),
      readDesire: () => ({ kind: 'ready', desired: DESIRED }),
      makeActuator: () => actuator,
      onConfigChange: (listener) => { fire = listener; return () => { fire = undefined; }; },
      ...timers,
    });
    sup.start();
    await flush();
    const before = actuator.calls.length;
    sup.stop();
    fire?.();
    await flush();
    expect(actuator.calls).toHaveLength(before);
  });
});
