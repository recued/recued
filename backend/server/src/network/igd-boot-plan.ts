/** D-273 P2 slice 3 — what to do at boot, when the router can be ASKED.
 *
 *  🔑 THE ROUTER'S VIEW AND OUR RECORD ARE TWO AXES, AND THE INTERESTING CASES
 *  ARE ONLY VISIBLE WHERE THEY CROSS. "Mapped to this machine" alone does not
 *  say whether WE mapped it; "we have a record" alone does not say whether it
 *  survived. Each axis on its own produces a plausible, wrong answer — the
 *  record alone would have us delete a port someone else has since taken, and
 *  the router alone would have us delete the owner's hand-made forward.
 *
 *  ⛔ THIS IS WHY IGD IS SAFER THAN NAT-PMP AND NOT MERELY WIDER. NAT-PMP cannot
 *  ask, so a client there must act on its record alone and delete blind. */

import type { IgdMappingEntry } from './igd-client.js';
import type { DesiredPortMapping, PortMappingRecord } from './port-mapping-plan.js';

export const IGD_BOOT_ACTIONS = [
  /** Nothing is there. Take it. */
  'map',
  /** Ours, healthy, pointing where it should. Re-assert to extend the lease. */
  'refresh',
  /** Ours, but wrong — a stale internal IP after DHCP, the wrong internal port,
   *  or switched off. Take it down and make it again. */
  'remap',
  /** ⛔ ALREADY FORWARDED TO US, AND WE DID NOT DO IT. The owner set this up by
   *  hand. The outcome they want is already true, so this SUCCEEDS WITHOUT
   *  ACTING — mapping on top would either conflict or create a duplicate
   *  dynamic entry we would later delete, taking the effect of their static
   *  forward with it. */
  'foreign_ok',
  /** ⚠ Something of the OWNER'S is on this port and it is not what we need —
   *  switched off, or pointing at the wrong internal port. Not ours to change,
   *  and not something to map over. Reported so they can see it. */
  'foreign_conflict',
  /** Another machine holds the port. */
  'conflict',
] as const;
export type IgdBootAction = (typeof IGD_BOOT_ACTIONS)[number];

export interface IgdBootPlan {
  action: IgdBootAction;
  /** Who the router says currently holds the port, when anyone does. */
  heldBy?: string;
  why: string;
}

/** Does this entry already do exactly what we want? */
const isServingUs = (
  observed: IgdMappingEntry,
  desired: DesiredPortMapping,
): boolean =>
  observed.internalClient === desired.internalIp
  && observed.internalPort === desired.internalPort
  // ⚠ ENABLED IS PART OF "SERVING". An entry that exists and is switched off
  // forwards nothing, and reads as mapped to anything that only asks whether an
  // entry exists.
  && observed.enabled;

export const planIgdBoot = (args: {
  /** What the router reports on the DESIRED external port. */
  observed: IgdMappingEntry | null;
  recorded: PortMappingRecord | null;
  desired: DesiredPortMapping;
}): IgdBootPlan => {
  const { observed, recorded, desired } = args;

  if (observed === null) {
    // ⚠ Covers BOTH "never mapped" and "ours vanished" — a router reboot, a
    // lease that lapsed while we were down, or someone clearing the table. The
    // action is the same, so they are not split; a caller that wants to notice
    // repeated disappearances can compare against `recorded` itself.
    return {
      action: 'map',
      why: recorded === null ? 'nothing mapped' : 'our mapping is gone',
    };
  }

  if (recorded === null) {
    // ⛔ WE NEVER MAPPED ANYTHING HERE, SO WHATEVER IS THERE IS THE OWNER'S.
    // Deleting a static forward someone set up by hand is not ours to do, and
    // IGD's DeletePortMapping will remove one just as happily as a dynamic one.
    return isServingUs(observed, desired)
      ? {
          action: 'foreign_ok',
          heldBy: observed.internalClient,
          why: 'already forwarded to this machine by hand',
        }
      : {
          action: 'foreign_conflict',
          heldBy: observed.internalClient,
          why: observed.enabled
            ? 'a mapping we did not create holds this port'
            : 'a mapping we did not create holds this port and is switched off',
        };
  }

  if (isServingUs(observed, desired)) {
    return { action: 'refresh', heldBy: observed.internalClient, why: 'ours and healthy' };
  }

  // ⛔⛔ OUR OLD ADDRESS IS NOT ANOTHER MACHINE. After a DHCP renewal the router
  // still says `192.168.1.42` while we are now `.77`, which is indistinguishable
  // from someone else's laptop — UNLESS the record names that address as ours.
  // Without this the most common recoverable case reads as a permanent conflict.
  //
  // ⚠ It is evidence, not proof: another host could have taken that address
  // since. The record ALSO says we created a mapping on this external port, and
  // that pair is the strongest signal available without a protocol that carries
  // ownership — which neither IGD nor NAT-PMP does.
  if (observed.internalClient === desired.internalIp
    || observed.internalClient === recorded.internalIp) {
    return {
      action: 'remap',
      heldBy: observed.internalClient,
      why: observed.internalClient !== desired.internalIp
        ? 'ours, left on our previous address'
        : observed.enabled
        ? 'ours, pointing at the wrong internal port'
        : 'ours, but switched off',
    };
  }

  return {
    action: 'conflict',
    heldBy: observed.internalClient,
    why: 'another machine holds this port',
  };
};

/** ⛔ BEFORE DELETING A RECORDED MAPPING, CHECK IT IS STILL OURS.
 *
 *  The record says we created a mapping at some external port. By boot time the
 *  router may have rebooted and someone else may hold it. A blind delete —
 *  which is all NAT-PMP can do — takes theirs. IGD can look first, and this is
 *  the check that turns that ability into safety.
 *
 *  ⚠ ASKED ABOUT THE RECORDED EXTERNAL PORT, NOT THE DESIRED ONE. If the router
 *  assigned a different port last time, looking up the desired one finds nothing
 *  and our real mapping is left alive somewhere else. */
export const mayDeleteRecorded = (
  observedAtRecordedPort: IgdMappingEntry | null,
  recorded: PortMappingRecord,
): boolean =>
  observedAtRecordedPort !== null
  && observedAtRecordedPort.internalClient === recorded.internalIp
  && observedAtRecordedPort.internalPort === recorded.internalPort;
