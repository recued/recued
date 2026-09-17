/** D-273 P1 — what to do about the port mapping, decided as data.
 *
 *  🔑 SEPARATED FROM THE CLIENT ON PURPOSE. Every interesting rule in D-273 is a
 *  comparison between what we recorded and what we now want; none of it needs a
 *  socket. Deciding here and executing elsewhere means the rules can be tested
 *  exhaustively without a gateway, and the executor stays small enough to read.
 *
 *  ⛔ THE RECORD IS THE AUTHORITY, NOT THE ROUTER. NAT-PMP has no enumeration —
 *  you can assert or delete, never ask. And where enumeration does exist (IGD,
 *  P2), "port 443 is mapped to this machine" still is not "we mapped it": the
 *  owner may have set a static forward by hand, and deleting that is not ours to
 *  do. So what we wrote down when we created a mapping is the only thing that
 *  tells us it is ours. */

import type { IgdMappingEntry } from './igd-client.js';
import { mayDeleteRecorded, planIgdBoot } from './igd-boot-plan.js';
import type { NatPmpProtocol } from './nat-pmp.js';

/** What we created, written down at creation time. Every field is part of the
 *  identity of the mapping, because a change to ANY of them means the recorded
 *  mapping is not the one we now want. */
export interface PortMappingRecord {
  gateway?: string;
  protocol: NatPmpProtocol;
  internalPort: number;
  /** ⛔ RECORDED BECAUSE IT CHANGES UNDER US. A DHCP renewal across a restart
   *  moves this machine's address, and the mapping encodes the OLD one — so a
   *  blindly-refreshed mapping points somewhere else on the LAN while the router
   *  reports a perfectly healthy forward. This field is what makes that
   *  detectable. */
  internalIp: string;
  /** ⚠ WHAT THE GATEWAY ASSIGNED, not what we asked for (RFC 6886 § 3.3). */
  externalPort: number;
  createdAt: number;
  /** The lifetime the gateway GRANTED, which renewal is timed off. */
  lifetimeSeconds: number;
}

export interface DesiredPortMapping {
  enabled: boolean;
  gateway?: string;
  protocol: NatPmpProtocol;
  internalPort: number;
  internalIp: string;
  externalPort: number;
}

export const PORT_MAPPING_PLAN_REASONS = [
  /** Disabled, nothing recorded. */
  'idle',
  /** Disabled with a record — take it down and stop. */
  'disabled',
  /** Enabled, nothing recorded yet. */
  'no_record',
  /** Enabled and the record still matches: re-assert to refresh the lease. */
  'unchanged',
  /** Enabled, but some part of the mapping's identity moved. */
  'params_changed',
  /** Enabled, and the recorded mapping is on a gateway we are no longer behind. */
  'gateway_changed',
] as const;
export type PortMappingPlanReason = (typeof PORT_MAPPING_PLAN_REASONS)[number];

export interface PortMappingPlan {
  /** Delete this before doing anything else, or `null` when there is nothing to
   *  take down.
   *
   *  ⛔ RELEASE FIRST, THEN MAP — and the order is a safety property, not a
   *  preference. If the new request then fails, the state is "no mapping": safe,
   *  and visible on the router step. Mapping first and releasing after would, on
   *  the same failure, leave a pinhole aimed at a port we no longer serve. */
  release: PortMappingRecord | null;
  /** ⛔ FALSE WHEN THE RECORD IS ON A DIFFERENT GATEWAY — a laptop that moved
   *  networks. The old mapping lives on a router we cannot reach, so there is
   *  nothing to send and nothing to wait for; the record is dropped and the new
   *  mapping made here. ⚠ The old one is NOT leaked into the void: it expires on
   *  its own gateway, which is exactly why D-273 leans on the lease rather than
   *  on an orderly teardown. */
  releaseReachable: boolean;
  /** Assert the desired mapping (after any release). */
  map: boolean;
  reason: PortMappingPlanReason;
}

/** True when the recorded mapping IS the one we want — the whole tuple, not just
 *  the port. ⚠ `internalIp` is in here for the DHCP case above; leaving it out is
 *  the version of this function that looks right and silently breaks. */
const isSameMapping = (
  recorded: PortMappingRecord,
  desired: DesiredPortMapping,
): boolean =>
  recorded.protocol === desired.protocol
  && recorded.internalPort === desired.internalPort
  && recorded.internalIp === desired.internalIp
  && recorded.externalPort === desired.externalPort;

export const planPortMapping = (
  recorded: PortMappingRecord | null,
  desired: DesiredPortMapping,
): PortMappingPlan => {
  if (!desired.enabled) {
    return recorded === null
      ? { release: null, releaseReachable: true, map: false, reason: 'idle' }
      : {
          release: recorded,
          releaseReachable: recorded.gateway === desired.gateway,
          map: false,
          reason: 'disabled',
        };
  }
  if (recorded === null) {
    return { release: null, releaseReachable: true, map: true, reason: 'no_record' };
  }
  if (recorded.gateway !== desired.gateway) {
    return {
      release: recorded,
      releaseReachable: false,
      map: true,
      reason: 'gateway_changed',
    };
  }
  // 🔑 REFRESH IS THE SAME OPERATION AS CREATE, so "continue across a restart"
  // needs no special case — re-asserting the tuple extends its lease.
  if (isSameMapping(recorded, desired)) {
    return { release: null, releaseReachable: true, map: true, reason: 'unchanged' };
  }
  return { release: recorded, releaseReachable: true, map: true, reason: 'params_changed' };
};

/** When to re-assert, given what the gateway granted.
 *
 *  ⚠ HALF THE GRANTED LIFETIME, floored — RFC 6886 § 3.3's guidance, and the
 *  reason is that one lost renewal must not cost the mapping. At half, a refresh
 *  can fail entirely and the next one still lands before expiry.
 *  ⛔ Timed off what was GRANTED, never what was requested: a gateway may shorten
 *  the lease, and a renewal clock set from the request would drift past expiry
 *  while every log line said it was renewed. */
export const renewalDelayMs = (lifetimeSeconds: number): number =>
  Math.max(1, Math.floor(lifetimeSeconds / 2)) * 1000;

// ── executing a plan ───────────────────────────────────────────────────────

/** The narrow slice of `NatPmpClient` an executor needs. Declared here so the
 *  executor can be tested without the protocol module, and so a future IGD
 *  client (P2) satisfies the same shape. */
export interface PortMappingActuator {
  map(args: {
    protocol: NatPmpProtocol;
    internalPort: number;
    externalPort: number;
    lifetimeSeconds: number;
  }): Promise<{ externalPort: number; lifetimeSeconds: number }>;
  /** ⛔⛔ BOTH PORTS, BECAUSE THE TWO PROTOCOLS KEY ON DIFFERENT ONES. NAT-PMP
   *  deletes by (internal port, protocol) with a zero lifetime; IGD's
   *  DeletePortMapping keys on (remote host, EXTERNAL port, protocol). The IGD
   *  adapter used to pass `internalPort` in the external slot, which deletes the
   *  wrong entry the moment a router assigns an external port we did not ask
   *  for — and that is exactly when a record is most worth having. */
  unmap(args: {
    protocol: NatPmpProtocol;
    internalPort: number;
    externalPort: number;
  }): Promise<void>;
  /** ⛔ ASK THE ROUTER WHAT IS ON A PORT. Present only for IGD; NAT-PMP cannot
   *  enumerate, and `undefined` is what tells the caller it must act blind.
   *  ⚠ `null` FROM THE CALL means "nothing is mapped there" — a different fact
   *  from "this protocol cannot be asked", which is this property being absent. */
  getMapping?: (args: {
    protocol: NatPmpProtocol;
    externalPort: number;
  }) => Promise<IgdMappingEntry | null>;
}

export interface PortMappingStoreLike {
  get(): PortMappingRecord | null;
  set(record: PortMappingRecord): void;
  clear(): void;
}

export const PORT_MAPPING_OUTCOMES = [
  'idle', 'mapped', 'released', 'unavailable', 'failed',
  /** ⛔ THESE THREE HAD NO PRODUCER UNTIL 2026-09-16. The contract carried them,
   *  the router-step copy rendered them, and nothing could emit one: the
   *  supervisor always ran the blind NAT-PMP-style plan, so `planIgdBoot` — the
   *  only thing that distinguishes an owner's forward from ours — never ran.
   *  ⇒ Every sentence about someone else holding the port was unreachable, and
   *  the code was free to delete a forward it should never touch. */
  'foreign_ok', 'foreign_conflict', 'conflict',
] as const;
export type PortMappingOutcome = (typeof PORT_MAPPING_OUTCOMES)[number];

export interface PortMappingResult {
  outcome: PortMappingOutcome;
  /** The LAN host the router says holds the port, when it says and when that
   *  is someone other than us. Only the IGD path can know this. */
  heldBy?: string;
  reason: PortMappingPlanReason;
  record: PortMappingRecord | null;
  /** Present when the gateway refused or never answered. ⚠ Carried rather than
   *  thrown: "your router has this switched off" is an ANSWER the router step
   *  should show, not a crash. */
  error?: string;
}

/** Run a plan: release first, then map. See `PortMappingPlan.release` for why
 *  that order is a safety property rather than a preference. */
export const applyPortMappingPlan = async (args: {
  plan: PortMappingPlan;
  desired: DesiredPortMapping;
  store: PortMappingStoreLike;
  actuator: PortMappingActuator;
  lifetimeSeconds: number;
  now: () => number;
}): Promise<PortMappingResult> => {
  const { plan, desired, store, actuator } = args;

  let releaseError: string | null = null;
  if (plan.release !== null) {
    if (plan.releaseReachable) {
      try {
        await actuator.unmap({
          protocol: plan.release.protocol,
          internalPort: plan.release.internalPort,
          externalPort: plan.release.externalPort,
        });
      } catch (err) {
        // ⛔ A FAILED RELEASE DOES NOT STOP THE REMAP, and it must not. The
        // mapping we could not take down expires on its own; refusing to
        // continue would leave the owner with neither the old mapping working
        // nor a new one — the worst of both, over a cleanup step.
        // ⚠ BUT IT IS REMEMBERED. Continuing is a decision about the REMAP; it
        // is not permission to report the cleanup as done.
        releaseError = err instanceof Error ? err.message : String(err);
      }
    }
    // ⚠ Cleared when we are moving on — keeping a record we have decided to
    // abandon would make the NEXT boot try to release it all over again, on a
    // gateway that may by then be a third one. The shutdown case below keeps it.
    if (plan.map || releaseError === null) store.clear();
  }

  if (!plan.map) {
    if (plan.release !== null && releaseError !== null) {
      // ⛔⛔ A REFUSED DELETE IS NOT A RELEASE. This path reported `released`
      // with `record: null` whatever the router said — so switching the feature
      // off told the owner the port was closed while the lease stayed open, and
      // dropped the only evidence that an opening we are responsible for is
      // still out there. The record is KEPT so the next reconcile can retry.
      return {
        outcome: 'failed',
        reason: plan.reason,
        record: plan.release,
        error: releaseError,
      };
    }
    return {
      outcome: plan.release === null ? 'idle' : 'released',
      reason: plan.reason,
      record: null,
    };
  }

  try {
    const result = await actuator.map({
      protocol: desired.protocol,
      internalPort: desired.internalPort,
      externalPort: desired.externalPort,
      lifetimeSeconds: args.lifetimeSeconds,
    });
    // ⛔ THE RECORD STORES WHAT THE GATEWAY GAVE, NOT WHAT WE ASKED FOR. The
    // assigned external port and the granted lifetime are both the gateway's to
    // choose; recording our request would make the next reconcile compare
    // against a mapping that never existed.
    const record: PortMappingRecord = {
      gateway: desired.gateway,
      protocol: desired.protocol,
      internalPort: desired.internalPort,
      internalIp: desired.internalIp,
      externalPort: result.externalPort,
      createdAt: args.now(),
      lifetimeSeconds: result.lifetimeSeconds,
    };
    store.set(record);
    return { outcome: 'mapped', reason: plan.reason, record };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ⚠ `unavailable` vs `failed`: a gateway that ANSWERED and said no is a
    // different thing to tell the owner than one that never answered, and only
    // the first is something they can go and change.
    const answered = typeof (err as { code?: unknown }).code === 'string';
    return {
      outcome: answered ? 'unavailable' : 'failed',
      reason: plan.reason,
      record: null,
      error: message,
    };
  }
};

// ── the IGD path: ask before you take, and ask before you delete ────────────

/** Reconcile against a router that can be ASKED.
 *
 *  ⛔⛔ THIS IS WHAT `planIgdBoot` AND `mayDeleteRecorded` WERE BUILT FOR, AND
 *  FOR TWO PHASES NOTHING CALLED THEM. `applyPortMappingPlan` above is the blind
 *  path — correct for NAT-PMP, which cannot enumerate — and the supervisor ran
 *  it for every protocol. On a router that CAN be asked that is not merely a
 *  missed feature: `AddPortMapping` overwrites an existing entry per the IGD
 *  spec § 2.4.16, so turning the feature on could silently take over an owner's
 *  hand-made forward, and turning it off could then delete it.
 *
 *  🔑 THE TWO QUESTIONS ARE DIFFERENT AND BOTH ARE ASKED HERE. Before MAPPING:
 *  is anything already on the port, and is it ours? Before DELETING: is the
 *  thing at our RECORDED external port still the thing we made? A client that
 *  asks only the first still deletes a stranger's mapping on the way out.
 *
 *  ⚠ THE DELETE CHECK USES THE RECORDED EXTERNAL PORT, NOT THE DESIRED ONE.
 *  A router may have assigned a port we did not ask for; looking up the desired
 *  one finds nothing and leaves our real mapping alive somewhere else. */
export const applyIgdReconcile = async (args: {
  desired: DesiredPortMapping;
  store: PortMappingStoreLike;
  actuator: PortMappingActuator & {
    getMapping: NonNullable<PortMappingActuator['getMapping']>;
  };
  lifetimeSeconds: number;
  now: () => number;
}): Promise<PortMappingResult> => {
  const { desired, store, actuator, lifetimeSeconds, now } = args;
  const recorded = store.get();

  const record = (externalPort: number, granted: number): PortMappingRecord => ({
    gateway: desired.gateway,
    protocol: desired.protocol,
    internalIp: desired.internalIp,
    internalPort: desired.internalPort,
    externalPort,
    lifetimeSeconds: granted,
    createdAt: now(),
  });

  /** Take our own mapping down, but only once the router agrees it is ours. */
  const releaseRecorded = async (
    rec: PortMappingRecord,
  ): Promise<{ released: boolean; reason: string }> => {
    const atRecorded = await actuator.getMapping({
      protocol: rec.protocol,
      externalPort: rec.externalPort,
    });
    if (!mayDeleteRecorded(atRecorded, rec)) {
      // ⚠ NOT A FAILURE, AND NOT A RELEASE. Our mapping is already gone — it
      // lapsed, or the router rebooted and someone else took the port. There is
      // nothing to take down, and taking down what IS there would be the exact
      // harm this function exists to prevent. The record goes; the outcome must
      // not claim we acted.
      store.clear();
      return { released: false, reason: 'our mapping is no longer on that port' };
    }
    await actuator.unmap({
      protocol: rec.protocol,
      internalPort: rec.internalPort,
      externalPort: rec.externalPort,
    });
    store.clear();
    return { released: true, reason: 'released' };
  };

  if (!desired.enabled) {
    if (recorded === null) return { outcome: 'idle', reason: 'idle', record: null };
    try {
      const { released, reason } = await releaseRecorded(recorded);
      return {
        outcome: released ? 'released' : 'idle',
        reason: 'disabled',
        record: null,
        ...(released ? {} : { error: reason }),
      };
    } catch (err) {
      // ⛔ A REFUSED DELETE IS NOT A RELEASE. The record is KEPT so the next
      // reconcile can try again — clearing it here would lose the only evidence
      // of an opening we are responsible for.
      return {
        outcome: 'failed',
        reason: 'disabled',
        record: recorded,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const observed = await actuator.getMapping({
    protocol: desired.protocol,
    externalPort: desired.externalPort,
  });
  const plan = planIgdBoot({ observed, recorded, desired });

  if (plan.action === 'foreign_ok' || plan.action === 'foreign_conflict'
    || plan.action === 'conflict') {
    // ⛔ NOTHING IS ATTEMPTED. Two of these are the owner's own configuration and
    // the third is another machine's; none is ours to overwrite. `foreign_ok` is
    // a SUCCESS — the outcome they wanted is already true.
    return {
      outcome: plan.action,
      // ⚠ `no_record` is the truth for all three: we hold nothing here and
      // deliberately created nothing.
      reason: 'no_record',
      record: null,
      // ⛔ `heldBy` IS ITS OWN FIELD, not smuggled into the error string. The rpc
      // contract has carried `held_by` since P3 with nothing to fill it, and the
      // router step wants to NAME the holder — a message a UI has to parse back
      // out of prose is the format-as-contract trap.
      ...(plan.heldBy !== undefined ? { heldBy: plan.heldBy } : {}),
      error: plan.why,
    };
  }

  try {
    if (plan.action === 'remap' && recorded !== null) {
      // ⚠ Gated even here. `remap` means the entry looks like ours — but "looks
      // like" is an internal-IP match, and the delete check asks the stronger
      // question at the port the record actually names.
      try { await releaseRecorded(recorded); } catch {
        // A release we could not complete does not stop the remap: the mapping
        // expires on its own, and refusing to continue leaves the owner with
        // neither the old one working nor a new one.
      }
    }
    const granted = await actuator.map({
      protocol: desired.protocol,
      internalPort: desired.internalPort,
      externalPort: desired.externalPort,
      lifetimeSeconds,
    });
    const next = record(granted.externalPort, granted.lifetimeSeconds);
    store.set(next);
    return {
      outcome: 'mapped',
      reason: recorded === null ? 'no_record'
        : plan.action === 'refresh' ? 'unchanged' : 'params_changed',
      record: next,
    };
  } catch (err) {
    return {
      outcome: 'failed',
      reason: recorded === null ? 'no_record' : 'params_changed',
      record: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
