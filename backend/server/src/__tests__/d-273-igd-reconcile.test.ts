/** D-273 — the IGD reconcile path: ask before you take, ask before you delete.
 *
 *  ⛔⛔ WHY THIS FILE EXISTS. `planIgdBoot` and `mayDeleteRecorded` shipped in P2
 *  with a full test suite of their own and NO PRODUCTION CALLER — the supervisor
 *  ran the blind NAT-PMP-style plan for every protocol, and the composition root
 *  dropped `getMapping` on the floor. Found by audit 2026-09-16.
 *
 *  🔑 THAT IS NOT A MISSING FEATURE, IT IS A DESTRUCTIVE ONE. IGD's
 *  `AddPortMapping` OVERWRITES whatever is on the port (spec § 2.4.16), so
 *  enabling the toggle could take over an owner's hand-made forward, and
 *  disabling it could then delete it. Their pure-function tests were green
 *  throughout, because the defect was that nothing called them — which is
 *  invisible to a test of the thing not being called.
 *
 *  ⇒ Every case here drives `applyIgdReconcile`, the composed path, and asserts
 *  on what the ACTUATOR WAS ASKED TO DO — not on a returned shape. What makes a
 *  forward survive is a `map` that never happens.
 */
import { describe, expect, it } from 'vitest';

import { applyIgdReconcile, type DesiredPortMapping, type PortMappingRecord }
  from '../network/port-mapping-plan.js';
import type { IgdMappingEntry } from '../network/igd-client.js';

const US = '192.168.1.42';
const DESIRED: DesiredPortMapping = {
  enabled: true,
  gateway: '192.168.1.1',
  protocol: 'tcp',
  internalPort: 443,
  externalPort: 443,
  internalIp: US,
};

const entry = (over: Partial<IgdMappingEntry> = {}): IgdMappingEntry => ({
  internalClient: US,
  internalPort: 443,
  enabled: true,
  leaseSeconds: 600,
  description: 'test',
  ...over,
});

const record = (over: Partial<PortMappingRecord> = {}): PortMappingRecord => ({
  gateway: '192.168.1.1',
  protocol: 'tcp',
  internalIp: US,
  internalPort: 443,
  externalPort: 443,
  lifetimeSeconds: 600,
  createdAt: 1_000,
  ...over,
});

/** A router we can interrogate, and a log of everything we asked it to do. */
const harness = (opts: {
  recorded?: PortMappingRecord | null;
  /** Keyed by external port — so a lookup at the WRONG port finds nothing. */
  table?: Record<number, IgdMappingEntry>;
  onUnmap?: () => void;
}) => {
  const calls: string[] = [];
  let stored = opts.recorded ?? null;
  const table = opts.table ?? {};
  return {
    calls,
    get stored() { return stored; },
    store: {
      get: () => stored,
      set: (r: PortMappingRecord) => { stored = r; },
      clear: () => { stored = null; },
    },
    actuator: {
      async map(a: { externalPort: number; lifetimeSeconds: number }) {
        calls.push(`map:${String(a.externalPort)}`);
        return { externalPort: a.externalPort, lifetimeSeconds: a.lifetimeSeconds };
      },
      async unmap(a: { internalPort: number; externalPort: number }) {
        calls.push(`unmap:ext=${String(a.externalPort)}:int=${String(a.internalPort)}`);
        opts.onUnmap?.();
      },
      async getMapping(a: { externalPort: number }) {
        calls.push(`ask:${String(a.externalPort)}`);
        return table[a.externalPort] ?? null;
      },
    },
  };
};

const run = async (h: ReturnType<typeof harness>, desired = DESIRED) =>
  applyIgdReconcile({
    desired,
    store: h.store,
    actuator: h.actuator,
    lifetimeSeconds: 600,
    now: () => 2_000,
  });

describe("D-273 — an owner's forward is not ours to take", () => {
  it("⛔⛔ DOES NOT MAP OVER a hand-made forward already serving this machine", async () => {
    // THE AUDIT'S SCENARIO. Owner forwarded 443 here by hand; we have no record.
    // The blind plan called `map`, and IGD overwrites — silently converting
    // their static entry into our dynamic one, which we later delete.
    const h = harness({ recorded: null, table: { 443: entry() } });
    const result = await run(h);
    expect(result.outcome).toBe('foreign_ok');
    expect(h.calls).toEqual(['ask:443']);
    expect(h.stored).toBeNull();
  });

  it('⛔ names the holder, rather than leaving the reader to guess', async () => {
    const h = harness({ recorded: null, table: { 443: entry({ internalClient: '192.168.1.9' }) } });
    const result = await run(h);
    expect(result.outcome).toBe('foreign_conflict');
    expect(result.heldBy).toBe('192.168.1.9');
    expect(h.calls).toEqual(['ask:443']);
  });

  it("⚠ a foreign entry that is SWITCHED OFF is still not ours to replace", async () => {
    // It forwards nothing, so it is not serving us — but it is still the
    // owner's row, and mapping over it would delete their configuration.
    const h = harness({ recorded: null, table: { 443: entry({ enabled: false }) } });
    expect((await run(h)).outcome).toBe('foreign_conflict');
    expect(h.calls).toEqual(['ask:443']);
  });

  it('maps when the port is genuinely free', async () => {
    const h = harness({ recorded: null, table: {} });
    const result = await run(h);
    expect(result.outcome).toBe('mapped');
    expect(h.calls).toEqual(['ask:443', 'map:443']);
  });

  it('re-asserts OUR healthy mapping to extend the lease', async () => {
    const h = harness({ recorded: record(), table: { 443: entry() } });
    expect((await run(h)).outcome).toBe('mapped');
    expect(h.calls).toEqual(['ask:443', 'map:443']);
  });

  it('⚠ remaps ours after a DHCP move, releasing the old row first', async () => {
    // The router still says .42 while we are now .77. Our record naming .42 is
    // what distinguishes this from a stranger's laptop.
    const h = harness({ recorded: record(), table: { 443: entry() } });
    const result = await run(h, { ...DESIRED, internalIp: '192.168.1.77' });
    expect(result.outcome).toBe('mapped');
    expect(h.calls).toEqual(['ask:443', 'ask:443', 'unmap:ext=443:int=443', 'map:443']);
  });
});

describe('D-273 — turning it off deletes only what we made', () => {
  it('⛔⛔ DOES NOT DELETE when the port is no longer ours', async () => {
    // The record says we mapped 443. Since then the router rebooted and someone
    // else took it. A blind delete — all NAT-PMP can do — takes theirs.
    const h = harness({
      recorded: record(),
      table: { 443: entry({ internalClient: '192.168.1.9' }) },
    });
    const result = await run(h, { ...DESIRED, enabled: false });
    expect(h.calls).toEqual(['ask:443']);
    // ⛔ NOT `released` — we released nothing.
    expect(result.outcome).toBe('idle');
    expect(h.stored).toBeNull();
  });

  it('releases when the router agrees the row is still ours', async () => {
    const h = harness({ recorded: record(), table: { 443: entry() } });
    const result = await run(h, { ...DESIRED, enabled: false });
    expect(result.outcome).toBe('released');
    expect(h.calls).toEqual(['ask:443', 'unmap:ext=443:int=443']);
    expect(h.stored).toBeNull();
  });

  it('⛔ asks at the RECORDED external port, not the desired one', async () => {
    // The router assigned 50000 last time. Looking up 443 finds nothing and
    // leaves our real mapping alive on 50000 forever.
    const h = harness({
      recorded: record({ externalPort: 50_000 }),
      table: { 50_000: entry() },
    });
    const result = await run(h, { ...DESIRED, enabled: false });
    expect(result.outcome).toBe('released');
    expect(h.calls).toEqual(['ask:50000', 'unmap:ext=50000:int=443']);
  });

  it('⛔⛔ a REFUSED delete is `failed` and KEEPS the record', async () => {
    // The opening is still out there. Reporting `released` and dropping the
    // record loses the only evidence of a hole we are responsible for.
    const h = harness({
      recorded: record(),
      table: { 443: entry() },
      onUnmap: () => { throw new Error('gateway refused'); },
    });
    const result = await run(h, { ...DESIRED, enabled: false });
    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('refused');
    expect(h.stored).not.toBeNull();
  });

  it('⚠ nothing recorded ⇒ nothing asked and nothing deleted', async () => {
    const h = harness({ recorded: null, table: { 443: entry() } });
    expect((await run(h, { ...DESIRED, enabled: false })).outcome).toBe('idle');
    expect(h.calls).toEqual([]);
  });
});
