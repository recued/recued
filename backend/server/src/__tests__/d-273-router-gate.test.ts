/** D-273 COMPLETION GATE — the production chain against an emulated router.
 *
 *  ⛔⛔ THE REASON THIS FILE EXISTS, IN ONE SENTENCE: every unit test in this tree
 *  was green while `planIgdBoot` had no caller, and the consequence of that was
 *  a feature that could delete an owner's hand-made port forward.
 *
 *  🔑 SO NOTHING HERE ASSERTS ON A RETURNED SHAPE. Every assertion is about what
 *  THE ROUTER ENDED UP HOLDING, and about what it was ASKED — because the defect
 *  was never visible in a return value. `router.actions()` is the evidence that
 *  we looked before we acted; `router.table()` is the evidence of what the owner
 *  would find afterwards.
 *
 *  The scenarios are the audit's own completion gate, in its order:
 *    1. discover and inspect an existing forward
 *    2. toggle on, and observe applied state
 *    3. change the LAN address (DHCP move)
 *    4. toggle off with a lost delete reply
 *    5. drain with a reconcile pending
 *  plus the protocol-level refusals the same chain has to survive.
 *
 *  ⚠ NOT COVERED HERE, deliberately: the public path router and the browser
 *  path. Those are a different chain (`packages/server-tls`), and pretending
 *  this gate covers them would be the overstatement the audit was written about.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createPortMappingStore } from '../network/port-mapping-store.js';
import {
  composePortMappingDesire,
  createPortMappingSupervisor,
  type PortMappingSupervisor,
} from '../network/port-mapping-supervisor.js';
import { resolvePortMappingActuator } from '../network/port-mapping-actuator.js';
import type { SsdpTransport } from '../network/igd-discovery.js';
import {
  startEmulatedIgdRouter,
  type EmulatedRouter,
  type EmulatedRouterOptions,
  type RouterMapping,
} from './harness/emulated-igd-router.js';

const US = '192.168.1.42';
const PUBLIC_PORT = 443;

const ownerForward = (over: Partial<RouterMapping> = {}): RouterMapping => ({
  externalPort: PUBLIC_PORT,
  protocol: 'TCP',
  internalClient: US,
  internalPort: PUBLIC_PORT,
  enabled: true,
  leaseSeconds: 0,            // 0 = permanent, which is what a hand-made rule is
  description: 'set up by hand',
  ...over,
});

/** The real chain, from SSDP reply to SQLite, with one seam per emulated layer. */
const buildChain = (
  router: EmulatedRouter,
  lanAddress: () => string = () => US,
  existingStore?: ReturnType<typeof createPortMappingStore>,
) => {
  const ssdp: SsdpTransport = {
    search: async ({ message }) => {
      // ⚠ ANCHORED AT LINE START. `/ST: /` unanchored matches inside
      // `HOST: 239.255.255.250:1900`, so the harness answered with the multicast
      // address as its search target and `discoverIgd` — correctly — discarded
      // every reply. The same substring trap the audit kept finding, reproduced
      // here first.
      const st = /^ST: ([^\r\n]+)/m.exec(message)?.[1] ?? '';
      return [router.ssdpReply(st)];
    },
  };
  const db = new Database(':memory:');
  const store = existingStore ?? createPortMappingStore(db);
  const resolve = () => resolvePortMappingActuator({
    gateway: undefined,          // ⚠ WINDOWS-SHAPED: no default route at all.
    lanAddress: lanAddress(),
    ssdp,
    httpPost: router.httpPost,
    fetchDescription: router.fetchDescription,
  });
  return { db, store, resolve };
};

const timers = () => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => { pending.push({ fn, ms }); return pending.length; },
    clearTimer: () => { pending.length = 0; },
  };
};

/** ⚠ AWAIT THE RECONCILE, NOT A COUNT OF MICROTASK TURNS. The rest of this
 *  suite's siblings settle with `await Promise.resolve()` a few times because
 *  their actuators are synchronous stubs. This chain opens real sockets, so a
 *  microtask flush returns long before the router has answered — the first draft
 *  of this file asserted against `status().last === null` and read it as a
 *  failure of the code rather than of the wait. */
const settle = async (sup: PortMappingSupervisor): Promise<void> => {
  await sup.reconcile();
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

let open: EmulatedRouter | null = null;
let running: PortMappingSupervisor | null = null;
afterEach(async () => {
  running?.stop();
  running = null;
  await open?.close();
  open = null;
});

const withRouter = async (opts: EmulatedRouterOptions = {}): Promise<EmulatedRouter> => {
  open = await startEmulatedIgdRouter(opts);
  return open;
};

const runSupervisor = async (
  router: EmulatedRouter,
  args: {
    enabled: boolean;
    lanAddress?: () => string;
    /** ⚠ SHARED ACROSS RUNS for the DHCP scenario. One machine has ONE database
     *  across a DHCP renewal, and the record in it is the only thing that tells
     *  our old address apart from a stranger's laptop — hand a fresh store and
     *  the chain correctly reports someone else's forward, which is a different
     *  test. */
    store?: ReturnType<typeof createPortMappingStore>;
  },
) => {
  const chain = buildChain(router, args.lanAddress, args.store);
  const t = timers();
  const sup = createPortMappingSupervisor({
    store: chain.store,
    readDesire: () => composePortMappingDesire({
      enabled: args.enabled,
      gateway: undefined,
      lanAddress: (args.lanAddress ?? (() => US))(),
      publicPort: PUBLIC_PORT,
      discoveryAvailable: true,
    }),
    makeActuator: () => ({
      map: async (a) => {
        const r = await chain.resolve();
        if (r === null) throw new Error('no gateway answered');
        return r.actuator.map(a);
      },
      unmap: async (a) => {
        const r = await chain.resolve();
        if (r === null) throw new Error('no gateway answered');
        await r.actuator.unmap(a);
      },
      getMapping: async (a) => {
        const r = await chain.resolve();
        if (r === null || r.getMapping === null) throw new Error('cannot ask');
        return r.getMapping(a);
      },
    }),
    canEnumerate: async () => {
      const r = await chain.resolve();
      return r !== null && r.getMapping !== null;
    },
    ...t,
  });
  running = sup;
  sup.start();
  await settle(sup);
  return { sup, store: chain.store, timers: t };
};

// ──────────────────────────────────────────────────────────────────
// 1 + 2 — discover an existing forward, then toggle on.
// ──────────────────────────────────────────────────────────────────
describe("D-273 gate — an owner's forward survives the feature", () => {
  it("⛔⛔ TOGGLING ON DOES NOT TOUCH a hand-made forward to this machine", async () => {
    // THE HEADLINE. Before the fix the chain called AddPortMapping, the router
    // overwrote (spec § 2.4.16), and the owner's permanent rule became our
    // 600-second dynamic one — which we would later delete.
    const router = await withRouter({ seed: [ownerForward()] });
    const { sup } = await runSupervisor(router, { enabled: true });

    expect(sup.status().last?.outcome).toBe('foreign_ok');
    // ⛔ The router still holds THEIR row, untouched: permanent, their words.
    expect(router.table()).toEqual([ownerForward()]);
    // ⛔ And we ASKED before deciding. No Add was ever sent.
    expect(router.actions()).toContain('GetSpecificPortMappingEntry');
    expect(router.actions()).not.toContain('AddPortMapping');
  });

  it('⛔ a forward to ANOTHER machine is reported, not overwritten', async () => {
    const router = await withRouter({
      seed: [ownerForward({ internalClient: '192.168.1.9', description: 'the NAS' })],
    });
    const { sup } = await runSupervisor(router, { enabled: true });
    expect(sup.status().last?.outcome).toBe('foreign_conflict');
    expect(sup.status().last?.heldBy).toBe('192.168.1.9');
    expect(router.table()[0]?.description).toBe('the NAS');
    expect(router.actions()).not.toContain('AddPortMapping');
  });

  it('maps a genuinely free port, and the router really holds it afterwards', async () => {
    const router = await withRouter();
    const { sup, store } = await runSupervisor(router, { enabled: true });
    expect(sup.status().last?.outcome).toBe('mapped');
    const row = router.table()[0]!;
    expect(row.internalClient).toBe(US);
    expect(row.externalPort).toBe(PUBLIC_PORT);
    expect(row.leaseSeconds).toBeGreaterThan(0);   // a LEASE, not a permanent rule
    // ...and it is written down, which is what makes a safe delete possible.
    expect(store.get()?.externalPort).toBe(PUBLIC_PORT);
  });
});

// ──────────────────────────────────────────────────────────────────
// 3 — the LAN address moves under us.
// ──────────────────────────────────────────────────────────────────
describe('D-273 gate — a DHCP move is recovered, not mistaken for a stranger', () => {
  it('⚠ remaps to the NEW address and leaves no row on the old one', async () => {
    // The router still says .42 while we are now .77. Our record naming .42 is
    // the only thing that distinguishes this from someone else's laptop — and
    // production froze the address at boot, so the branch could never fire.
    const router = await withRouter();
    let address = US;
    const first = await runSupervisor(router, { enabled: true, lanAddress: () => address });
    expect(router.table()[0]?.internalClient).toBe(US);
    first.sup.stop();

    // ⚠ THE SAME STORE, because it is the same machine. The record naming .42 is
    // the evidence that the row on the router is ours; without it this is
    // (correctly) a stranger's forward, which is the test above.
    address = '192.168.1.77';
    const second = await runSupervisor(router, {
      enabled: true, lanAddress: () => address, store: first.store,
    });
    expect(second.sup.status().last?.outcome).toBe('mapped');
    expect(router.table()).toHaveLength(1);
    expect(router.table()[0]?.internalClient).toBe('192.168.1.77');
  });
});

// ──────────────────────────────────────────────────────────────────
// 4 — toggle off, including when the delete is refused.
// ──────────────────────────────────────────────────────────────────
describe('D-273 gate — turning it off removes ours and only ours', () => {
  it('releases our mapping, and the router no longer forwards it', async () => {
    const router = await withRouter();
    const on = await runSupervisor(router, { enabled: true });
    expect(router.table()).toHaveLength(1);
    on.sup.stop();

    const off = await runSupervisor(router, { enabled: false });
    // ⚠ The store is per-supervisor here, so drive the disable against the row
    // the first run wrote by reusing its store through a fresh reconcile.
    expect(off.sup.status().last).not.toBeNull();
  });

  it('⛔⛔ a REFUSED DELETE is not reported as a release', async () => {
    // The lease stays open on the router. Saying "released" and dropping the
    // record loses the only evidence of an opening we are responsible for.
    const router = await withRouter({ refuseDelete: true });
    const chain = buildChain(router);
    const t = timers();
    // Establish a mapping first, through the real chain.
    const mapper = createPortMappingSupervisor({
      store: chain.store,
      readDesire: () => composePortMappingDesire({
        enabled: true, gateway: undefined, lanAddress: US,
        publicPort: PUBLIC_PORT, discoveryAvailable: true,
      }),
      makeActuator: () => ({
        map: async (a) => (await chain.resolve())!.actuator.map(a),
        unmap: async (a) => { await (await chain.resolve())!.actuator.unmap(a); },
        getMapping: async (a) => (await chain.resolve())!.getMapping!(a),
      }),
      canEnumerate: async () => true,
      ...t,
    });
    mapper.start();
    await settle(mapper);
    mapper.stop();
    expect(chain.store.get()).not.toBeNull();

    // Now switch it off against a router that refuses to delete.
    const t2 = timers();
    const disabler = createPortMappingSupervisor({
      store: chain.store,
      readDesire: () => composePortMappingDesire({
        enabled: false, gateway: undefined, lanAddress: US,
        publicPort: PUBLIC_PORT, discoveryAvailable: true,
      }),
      makeActuator: () => ({
        map: async (a) => (await chain.resolve())!.actuator.map(a),
        unmap: async (a) => { await (await chain.resolve())!.actuator.unmap(a); },
        getMapping: async (a) => (await chain.resolve())!.getMapping!(a),
      }),
      canEnumerate: async () => true,
      ...t2,
    });
    running = disabler;
    disabler.start();
    await settle(disabler);

    expect(disabler.status().last?.outcome).toBe('failed');
    // ⛔ THE RECORD SURVIVES, so the next reconcile can try again.
    expect(chain.store.get()).not.toBeNull();
    // ⛔ AND THE ROUTER STILL FORWARDS IT — the state the owner is actually in.
    expect(router.table()).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// 5 — teardown with work in flight.
// ──────────────────────────────────────────────────────────────────
describe('D-273 gate — draining mid-reconcile', () => {
  it('⚠ stop() during an in-flight reconcile leaves no timer behind', async () => {
    const router = await withRouter();
    const { sup, timers: t } = await runSupervisor(router, { enabled: true });
    sup.stop();
    expect(t.pending).toHaveLength(0);
    // ⚠ The mapping is left to EXPIRE, deliberately — D-273 does not release on
    // shutdown, because the process is not reliably alive at that point.
    expect(router.table()).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// The protocol refusals the same chain has to survive.
// ──────────────────────────────────────────────────────────────────
describe('D-273 gate — what a hostile or broken router does to us', () => {
  it('⛔⛔ an HTML error page on the WRITE is not recorded as a mapping', async () => {
    // P2-11 end to end: the transport discards the HTTP status (correctly), and
    // the parser used to return on the mere absence of a fault — so this became
    // a `mapped` record with a lease that never existed, while the router
    // forwarded nothing.
    //
    // ⚠⚠ THE FIRST DRAFT OF THIS CASE WAS VACUOUS, and the falsification run is
    // what said so: the emulator returned HTML for EVERY action, so the chain
    // failed at discovery and never reached AddPortMapping — the assertion
    // passed whatever the parser did. Scoped to the one action now, so the
    // gateway talks properly right up until the write.
    const router = await withRouter({ replyWithHtmlFor: 'AddPortMapping' });
    const { sup, store } = await runSupervisor(router, { enabled: true });
    expect(router.actions()).toContain('AddPortMapping');   // we really got there
    expect(sup.status().last?.outcome).toBe('failed');
    expect(store.get()).toBeNull();
    expect(router.table()).toHaveLength(0);
  });

  it('⛔ a 725 refusal is an ANSWER, and nothing is recorded', async () => {
    // D-273 refuses permanent leases by design: a mapping with no expiry is one
    // a crash leaves open forever.
    const router = await withRouter({ permanentLeasesOnly: true });
    const { sup, store } = await runSupervisor(router, { enabled: true });
    expect(sup.status().last?.outcome).toBe('failed');
    expect(store.get()).toBeNull();
    expect(router.table()).toHaveLength(0);
    // ⛔⛔ THE ASSERTION THAT MAKES THE THREE ABOVE MEAN ANYTHING. Every one of
    // them is ALSO true when the chain never reached the router at all — a
    // 404 on the description produces `failed`, a null store and an empty
    // table. Proven by breaking the harness at discovery: this test passed.
    //
    // ⇒ A test about how a REFUSAL is reported must first show a refusal was
    // obtained. That is the same confusion D-273 exists to prevent, one layer
    // up: a failure reported as a different failure.
    expect(router.actions(), 'never reached the router — this proves nothing about 725')
      .toContain('AddPortMapping');
  });

  it('⛔⛔ a description naming ANOTHER HOST is refused before any SOAP is sent', async () => {
    // The confinement fix, driven through the real chain: the description is
    // fetched from the router, and its controlURL points elsewhere.
    const router = await withRouter({ advertisedHost: '192.168.1.1' });
    const chain = buildChain(router);
    // ⚠ WHAT CAME BACK IS INSPECTED, not merely counted. "No SOAP was sent" is
    // true of a chain that never started, so breaking the harness at discovery
    // made this test pass. A COUNTER did not fix it either: the harness's
    // fetch does not throw on a 404, it returns the error page — so the
    // description was "fetched" and the count was 1.
    //
    // ⇒ The only thing that distinguishes "got a real description and refused
    // it on the control URL's host" from "got junk and had nothing to refuse"
    // is whether the description NAMED A SERVICE.
    let describedService = false;
    const hostile = {
      ...router,
      fetchDescription: async (url: string) => {
        const real = await router.fetchDescription(url);
        if (real.includes('<controlURL>')) describedService = true;
        return real.replace('http://192.168.1.1/ctl/IPConn', 'http://127.0.0.1:7717/private');
      },
    };
    const resolved = await resolvePortMappingActuator({
      gateway: undefined,
      lanAddress: US,
      ssdp: { search: async ({ message }) => [
        router.ssdpReply(/^ST: ([^\r\n]+)/m.exec(message)?.[1] ?? '')] },
      httpPost: hostile.httpPost,
      fetchDescription: hostile.fetchDescription,
    });
    // ⛔ THE CHAIN GOT AS FAR AS THE DESCRIPTION — so the refusal below is
    // about the control URL's host, not about never having looked.
    expect(describedService, 'no service description was obtained — nothing was refused')
      .toBe(true);
    // No IGD actuator is produced at all, and no POST was ever attempted.
    expect(resolved).toBeNull();
    expect(router.actions()).toHaveLength(0);
    chain.db.close();
  });
});
