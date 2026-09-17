/** D-273 P2 slice 3 — the boot matrix, both axes crossed. */

import { describe, expect, it } from 'vitest';
import { mayDeleteRecorded, planIgdBoot } from '../network/igd-boot-plan.js';
import type { IgdMappingEntry } from '../network/igd-client.js';
import type { DesiredPortMapping, PortMappingRecord } from '../network/port-mapping-plan.js';

const DESIRED: DesiredPortMapping = {
  enabled: true, gateway: '192.168.1.1', protocol: 'tcp',
  internalPort: 443, internalIp: '192.168.1.42', externalPort: 443,
};
const RECORD: PortMappingRecord = {
  gateway: '192.168.1.1', protocol: 'tcp', internalPort: 443,
  internalIp: '192.168.1.42', externalPort: 443,
  createdAt: 1, lifetimeSeconds: 600,
};
const entry = (over: Partial<IgdMappingEntry> = {}): IgdMappingEntry => ({
  internalClient: '192.168.1.42', internalPort: 443, enabled: true,
  leaseSeconds: 600, description: 'Recued', ...over,
});

const plan = (observed: IgdMappingEntry | null, recorded: PortMappingRecord | null,
  desired = DESIRED) => planIgdBoot({ observed, recorded, desired });

describe('D-273 — the boot matrix', () => {
  it('nothing mapped, no record ⇒ map', () => {
    expect(plan(null, null)).toMatchObject({ action: 'map', why: 'nothing mapped' });
  });

  it('⚠ nothing mapped WITH a record ⇒ still map — ours vanished', () => {
    // Router reboot, a lease that lapsed while we were down, or someone clearing
    // the table. Same action; the `why` is what a caller watching for repeats
    // would read.
    expect(plan(null, RECORD)).toMatchObject({ action: 'map', why: 'our mapping is gone' });
  });

  it('ours and healthy ⇒ refresh', () => {
    expect(plan(entry(), RECORD)).toMatchObject({ action: 'refresh' });
  });

  it('⛔⛔ mapped to us with NO RECORD ⇒ foreign_ok — the owner did it by hand', () => {
    // The outcome they want is already true. Mapping on top would either
    // conflict or create a duplicate dynamic entry we would later delete,
    // taking the effect of their static forward with it.
    expect(plan(entry(), null)).toMatchObject({
      action: 'foreign_ok', heldBy: '192.168.1.42',
    });
  });

  it('⛔⛔ mapped to our OLD address ⇒ remap, NOT conflict', () => {
    // After a DHCP renewal the router still says `.42` while we are `.77`, which
    // is indistinguishable from someone else's laptop unless the RECORD names
    // that address as ours. Without it the commonest recoverable case reads as a
    // permanent conflict.
    const moved = { ...DESIRED, internalIp: '192.168.1.77' };
    expect(plan(entry({ internalClient: '192.168.1.42' }), RECORD, moved))
      .toMatchObject({ action: 'remap', why: 'ours, left on our previous address' });
  });

  it('⛔ and WITHOUT the record, that same entry is a foreign conflict', () => {
    // The pair is what distinguishes them. This is the assertion that proves the
    // record is load-bearing rather than decorative.
    const moved = { ...DESIRED, internalIp: '192.168.1.77' };
    expect(plan(entry({ internalClient: '192.168.1.42' }), null, moved))
      .toMatchObject({ action: 'foreign_conflict' });
  });

  it('⛔ ENABLED IS PART OF "SERVING" — a switched-off entry of ours ⇒ remap', () => {
    // An entry that exists and is disabled forwards nothing, and reads as mapped
    // to anything that only asks whether an entry exists.
    expect(plan(entry({ enabled: false }), RECORD))
      .toMatchObject({ action: 'remap', why: 'ours, but switched off' });
  });

  it('⚠ a switched-off entry belonging to the OWNER ⇒ foreign_conflict', () => {
    // Broken, but not ours to fix — and deleting a static forward is not ours to
    // do either.
    expect(plan(entry({ enabled: false }), null)).toMatchObject({
      action: 'foreign_conflict',
      why: 'a mapping we did not create holds this port and is switched off',
    });
  });

  it('ours but pointing at the wrong internal port ⇒ remap', () => {
    expect(plan(entry({ internalPort: 8443 }), RECORD))
      .toMatchObject({ action: 'remap', why: 'ours, pointing at the wrong internal port' });
  });

  it('another machine ⇒ conflict, and it names who', () => {
    expect(plan(entry({ internalClient: '192.168.1.99' }), RECORD)).toMatchObject({
      action: 'conflict', heldBy: '192.168.1.99',
    });
  });

  it('⚠ every branch produces a `why` — a bare action is not reportable', () => {
    const all = [
      plan(null, null), plan(null, RECORD), plan(entry(), RECORD), plan(entry(), null),
      plan(entry({ enabled: false }), null), plan(entry({ internalPort: 8443 }), RECORD),
      plan(entry({ internalClient: '192.168.1.99' }), RECORD),
    ];
    for (const p of all) expect(p.why.length).toBeGreaterThan(0);
  });
});

describe('D-273 — may we delete what we recorded?', () => {
  it('⛔⛔ NO when someone else now holds that port', () => {
    // The record says we created a mapping there. By boot the router may have
    // rebooted and someone else taken it. A blind delete — all NAT-PMP can do —
    // takes theirs. This is the check that turns IGD's ability to look into
    // actual safety.
    expect(mayDeleteRecorded(entry({ internalClient: '192.168.1.99' }), RECORD)).toBe(false);
  });

  it('⛔ NO when nothing is there — there is nothing of ours to remove', () => {
    expect(mayDeleteRecorded(null, RECORD)).toBe(false);
  });

  it('⛔ NO when the internal port does not match what we recorded', () => {
    expect(mayDeleteRecorded(entry({ internalPort: 9999 }), RECORD)).toBe(false);
  });

  it('yes when it is still exactly what we recorded', () => {
    expect(mayDeleteRecorded(entry(), RECORD)).toBe(true);
  });

  it('⚠ a DISABLED entry that is otherwise ours is still ours to delete', () => {
    // Enabled decides whether it SERVES; it does not decide whose it is.
    expect(mayDeleteRecorded(entry({ enabled: false }), RECORD)).toBe(true);
  });
});
