/** D-273 P1 — owns the port mapping's whole life: reconcile at boot, renew while
 *  running, react to config, take it down on the toggle.
 *
 *  🔑 EVERY TRIGGER IS THE SAME OPERATION. Boot, a renewal falling due, the owner
 *  changing `public_port`, the toggle going off — all of them are "look at what
 *  we recorded, look at what we want, act on the difference". Because re-asserting
 *  a mapping IS how NAT-PMP refreshes it, renewal needed no separate path; it is
 *  a reconcile that happens to find nothing changed.
 *
 *  ⛔ AND NOTHING RUNS ON SHUTDOWN, DELIBERATELY (D-273). The server has no signal
 *  handler and never calls its own `close()`, so a teardown hook would fire on
 *  approximately no real stop. The lease is what bounds the hole; reconcile-on-
 *  start is what cleans up after it. */

import {
  detectPortMappingSupport,
  type PortMappingSupport,
} from './port-mapping-support.js';
import {
  applyIgdReconcile,
  applyPortMappingPlan,
  planPortMapping,
  renewalDelayMs,
  type DesiredPortMapping,
  type PortMappingActuator,
  type PortMappingResult,
  type PortMappingStoreLike,
} from './port-mapping-plan.js';

/** ⚠ TEN MINUTES, AND IT IS THE SECURITY KNOB. With no release on shutdown, a
 *  server that stops and never comes back leaves the port open for one lease —
 *  so this number IS the worst-case exposure. Renewal costs one UDP datagram to
 *  the local gateway every five minutes, which buys a tight bound for nothing. */
export const PORT_MAPPING_LIFETIME_SECONDS = 600;

/** After a failure, try again on this cadence rather than the renewal one: there
 *  is no mapping to renew, and a gateway that was briefly busy should not cost
 *  the owner their away access until the next full lease would have elapsed. */
export const PORT_MAPPING_RETRY_DELAY_MS = 60_000;

/** How often to re-ask the router what it supports while we hold no mapping.
 *
 *  ⚠ NOT A RETRY — there is nothing to retry. It is a cache expiry over a fact
 *  that lives in the router's settings, which the owner can change without
 *  telling us. */
export const PORT_MAPPING_IDLE_RECHECK_MS = 15 * 60_000;

/** Why we cannot act at all — distinct from the gateway refusing, which is an
 *  answer. ⚠ `no_lan_address` is the loopback fallback: with no LAN interface
 *  there is no internal address to forward TO, and mapping to `127.0.0.1` would
 *  ask the router to send the internet to itself. */
export type PortMappingUnavailable = 'no_gateway' | 'no_lan_address';

export type PortMappingDesire =
  | { kind: 'ready'; desired: DesiredPortMapping }
  | { kind: 'unavailable'; reason: PortMappingUnavailable };

export interface PortMappingStatus {
  last: PortMappingResult | null;
  unavailable: PortMappingUnavailable | null;
  /** Unix-ms of the last reconcile, or null before the first. */
  checkedAt: number | null;
  /** D-273 P0 — what the gateway says it supports.
   *
   *  🔑 ANSWERED EVEN WHEN THE TOGGLE IS OFF, which is the whole of P0's value:
   *  the router step can say "your router supports this, switch it on" or "your
   *  router has it turned off" or "your ISP is NATing upstream, this will not
   *  help" WITHOUT anyone having opened a port. Detection asks for an address;
   *  it never requests a mapping. */
  support: PortMappingSupport | null;
}

export interface PortMappingSupervisor {
  start(): void;
  stop(): void;
  status(): PortMappingStatus;
  /** Run a reconcile now. Safe to call concurrently — see the queue below. */
  reconcile(): Promise<void>;
}

export interface CreatePortMappingSupervisorOptions {
  store: PortMappingStoreLike;
  /** Read the current intent. Called fresh on EVERY reconcile — the toggle, the
   *  public port, this machine's LAN address and the gateway can all have moved
   *  since the last one, and a cached copy is how a supervisor keeps renewing a
   *  mapping the owner switched off. */
  readDesire: () => PortMappingDesire;
  /** Built per reconcile from the CURRENT gateway. ⚠ Never reused across a
   *  gateway change: a client pinned at construction would send this network's
   *  requests to the last network's router. */
  /** ⚠ `gateway` MAY BE UNDEFINED — see `composePortMappingDesire`. SSDP needs
   *  no default route, so a host that cannot read one (win32, always) can still
   *  reach an IGD. A factory that requires the address rules out the protocol
   *  that does not need it. */
  makeActuator: (gateway: string | undefined) => PortMappingActuator;
  lifetimeSeconds?: number;
  now?: () => number;
  /** ⚠ The handle is OPAQUE on purpose. `ReturnType<typeof setTimeout>` is
   *  `number` under a DOM lib and `Timeout` under Node's, so naming it drags
   *  this module's compilability into whichever lib set the consuming tsconfig
   *  happens to pull in — a divergence vitest cannot see and `typecheck:tests`
   *  can. Nothing here inspects the handle; it only hands it back. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Can the gateway that answers right now be ASKED what is on a port?
   *
   *  ⛔ THIS DECIDES WHETHER AN OWNER'S FORWARD IS SAFE. True selects the path
   *  that looks before it maps and looks before it deletes; false selects the
   *  blind NAT-PMP plan, which overwrites and deletes on the strength of our own
   *  record alone. Omitted ⇒ false, because acting blind is what a client that
   *  cannot ask must do — and assuming the safer path without the capability
   *  would make every `getMapping` call throw mid-reconcile.
   *
   *  ⚠ A THROW HERE READS AS FALSE. A capability probe that fails is not a
   *  capability. */
  canEnumerate?: () => Promise<boolean>;
  /** Runtime-config subscription. Returns its unsubscribe. */
  onConfigChange?: (listener: () => void) => () => void;
  /** D-273 P0 — ask the gateway what it supports. Omitted → no detection, and
   *  `status().support` stays null (nobody asked), never a guess. */
  detect?: (gateway: string | undefined) => Promise<PortMappingSupport>;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export const createPortMappingSupervisor = (
  opts: CreatePortMappingSupervisorOptions,
): PortMappingSupervisor => {
  const now = opts.now ?? Date.now;
  // ⚠ The cast lives HERE, at the one boundary that knows the real handle type,
  // rather than leaking a lib-dependent type through the seam. Nothing else in
  // this module looks at a timer handle.
  const setTimer: (fn: () => void, ms: number) => unknown =
    opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer: (handle: unknown) => void =
    opts.clearTimer ?? ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const lifetimeSeconds = opts.lifetimeSeconds ?? PORT_MAPPING_LIFETIME_SECONDS;

  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = true;
  let status: PortMappingStatus = {
    last: null, unavailable: null, checkedAt: null, support: null,
  };

  // ⛔ ONE RECONCILE AT A TIME, AND A CHANGE DURING ONE IS NOT DROPPED. Coalescing
  // into the in-flight run would return an answer computed against the OLD
  // intent, so a `public_port` edit landing mid-renewal would silently not take
  // effect. Queue exactly one follow-up instead.
  let inflight: Promise<void> | null = null;
  let queued = false;

  const schedule = (ms: number): void => {
    if (timer !== null) clearTimer(timer);
    if (stopped) return;
    timer = setTimer(() => { timer = null; void reconcile(); }, ms);
  };

  const runOnce = async (): Promise<void> => {
    const desire = opts.readDesire();
    if (desire.kind === 'unavailable') {
      // ⚠ Nothing is attempted and nothing is cleared. A record we cannot act on
      // is not a record we should forget — the mapping it describes is still out
      // there, and it expires by itself.
      status = {
        last: null,
        unavailable: desire.reason,
        checkedAt: now(),
        // ⛔ `null` client ⇒ `unknown`, which is the honest answer: with no
        // gateway to ask, we know nothing about a router rather than knowing it
        // cannot do this.
        support: await detectPortMappingSupport(null),
      };
      return;
    }
    const { desired } = desire;
    const actuator = opts.makeActuator(desired.gateway);
    // ⚠ DETECTION RUNS FIRST AND SEPARATELY, on every reconcile, because it is
    // the only part that answers while the toggle is OFF — the router step needs
    // "your router supports this" before anyone decides to switch it on.
    const support = opts.detect !== undefined
      ? await opts.detect(desired.gateway)
      : null;
    // ⛔⛔ ASK THE ROUTER WHEN THE ROUTER CAN BE ASKED. This used to run the blind
    // plan for EVERY protocol, which is correct for NAT-PMP — it cannot
    // enumerate — and unsafe for IGD, where `AddPortMapping` overwrites whatever
    // is there (spec § 2.4.16). An owner's hand-made forward could be taken over
    // on enable and deleted on disable, and `planIgdBoot` / `mayDeleteRecorded`
    // sat with no caller for two phases while that was true.
    //
    // ⚠ THE PRESENCE OF `getMapping` IS THE DISCRIMINATOR, not the protocol name.
    // A caller that branched on `'igd'` would be one composition edit away from
    // asserting a capability the actuator it was handed does not have.
    // ⚠ ASKED, NOT ASSUMED. The composed actuator always DEFINES `getMapping` —
    // it cannot know at construction which protocol will answer — so the
    // presence of the method says nothing. `canEnumerate` is resolved against
    // the gateway that actually answers, per reconcile, because the answer
    // changes when the machine moves networks.
    const canEnumerate = opts.canEnumerate !== undefined
      ? await opts.canEnumerate().catch(() => false)
      : false;
    const result = canEnumerate
      ? await applyIgdReconcile({
          desired,
          store: opts.store,
          actuator: actuator as PortMappingActuator & {
            getMapping: NonNullable<PortMappingActuator['getMapping']>;
          },
          lifetimeSeconds,
          now,
        })
      : await applyPortMappingPlan({
          plan: planPortMapping(opts.store.get(), desired),
          desired,
          store: opts.store,
          actuator,
          lifetimeSeconds,
          now,
        });
    status = { last: result, unavailable: null, checkedAt: now(), support };

    if (result.outcome === 'mapped' && result.record !== null) {
      opts.log?.('info',
        `[port-mapping] ${desired.gateway} → external ${String(result.record.externalPort)}`
        + ` for ${String(result.record.lifetimeSeconds)}s (${result.reason})`);
      // ⛔ Timed off the GRANTED lifetime on the record, never the requested one.
      schedule(renewalDelayMs(result.record.lifetimeSeconds));
      return;
    }
    if (result.outcome === 'unavailable' || result.outcome === 'failed') {
      opts.log?.('warn', `[port-mapping] ${result.outcome}: ${result.error ?? 'unknown'}`);
      schedule(PORT_MAPPING_RETRY_DELAY_MS);
      return;
    }
    // ⛔⛔ IDLE STILL RE-DETECTS, SLOWLY. This used to schedule NOTHING on
    // `idle` / `released` — "the next reconcile comes from a config change" —
    // which meant an owner who switched UPnP ON IN THEIR ROUTER kept being shown
    // the `disabled`/`unsupported` answer forever. Nothing they could do in
    // Recued would refresh it, because the only thing that would was a Recued
    // config write.
    //
    // 🔑 DETECTION IS THE HALF THAT MATTERS WHILE THE FEATURE IS OFF, and it is
    // the half whose input lives OUTSIDE this process. A cache with no
    // expiry over a fact the user can change elsewhere is a cache that is
    // eventually always wrong.
    //
    // ⚠ Deliberately slow. A reconcile in this state costs one detection — an
    // SSDP search and at most one SOAP call — so a quarter-hour keeps the page
    // honest without making an off feature chatty on every network it sits on.
    schedule(PORT_MAPPING_IDLE_RECHECK_MS);
  };

  const reconcile = async (): Promise<void> => {
    if (inflight !== null) {
      queued = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        await runOnce();
      } catch (err) {
        // ⛔ A SUPERVISOR MUST NOT DIE OF A RECONCILE. Everything below it is
        // best-effort network work; an unexpected throw here would stop renewal
        // for the life of the process and the mapping would lapse silently.
        opts.log?.('warn',
          `[port-mapping] reconcile threw: ${err instanceof Error ? err.message : String(err)}`);
        schedule(PORT_MAPPING_RETRY_DELAY_MS);
      } finally {
        inflight = null;
        if (queued) {
          queued = false;
          void reconcile();
        }
      }
    })();
    return inflight;
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      unsubscribe = opts.onConfigChange?.(() => { void reconcile(); }) ?? null;
      void reconcile();
    },
    stop() {
      stopped = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      unsubscribe?.();
      unsubscribe = null;
      // ⚠ NO RELEASE HERE. D-273: the mapping expires rather than being taken
      // down, because the process is not reliably alive at this point anyway.
    },
    status: () => status,
    reconcile,
  };
};

// ── composing the real intent ──────────────────────────────────────────────

/** Build the current intent from the three things it depends on.
 *
 *  ⛔ `internalIp` IS THE ADVERTISED LAN ADDRESS, NOT THE BIND ADDRESS.
 *  `resolveLanAddress` returns two different values on purpose: what to BIND
 *  (`0.0.0.0`, so loopback stays served alongside the LAN) and what to ADVERTISE
 *  (the actual LAN IP). A port mapping must name a real host — asking a router to
 *  forward the internet to `0.0.0.0` is not a mapping, it is a malformed one.
 *
 *  ⚠ And a loopback advertised address means NO LAN INTERFACE WAS FOUND, which
 *  makes a mapping meaningless rather than merely awkward: there is nothing on
 *  the network for the router to forward to. */
export const composePortMappingDesire = (inputs: {
  enabled: boolean;
  gateway: string | undefined;
  lanAddress: string;
  publicPort: number;
  /** Can we look for a router WITHOUT a default-route address — i.e. is SSDP
   *  wired? ⚠ Omitted ⇒ false, so a composition that never wired discovery keeps
   *  the honest `no_gateway`. */
  discoveryAvailable?: boolean;
}): PortMappingDesire => {
  if (inputs.gateway === undefined || inputs.gateway.length === 0) {
    // ⛔⛔ THE COMMENT HERE USED TO NAME THE FIX AND THE CODE DEFEATED IT. It
    // said "UPnP's multicast discovery (P2) is what covers this" — and then
    // returned `unavailable` before discovery could be attempted, so on win32,
    // where `readDefaultRouteGateway()` ALWAYS returns undefined, neither
    // detection nor mapping ever reached the IGD implementation. UPnP was
    // unreachable on Windows for the whole of P2 and P3.
    //
    // 🔑 SSDP IS MULTICAST AND NEEDS NO DEFAULT ROUTE. Only NAT-PMP needs a
    // unicast target. So the absence of a gateway rules out ONE protocol, not
    // the feature — and the device discovery finds IS the gateway identity.
    if (inputs.discoveryAvailable !== true) {
      return { kind: 'unavailable', reason: 'no_gateway' };
    }
  }
  if (inputs.lanAddress.startsWith('127.') || inputs.lanAddress === '::1') {
    return { kind: 'unavailable', reason: 'no_lan_address' };
  }
  return {
    kind: 'ready',
    desired: {
      enabled: inputs.enabled,
      gateway: inputs.gateway,
      protocol: 'tcp',
      // ⚠ Internal and external are the SAME port by construction here: the
      // address the webclient hands out is built from `public_port`, so a
      // mapping that landed on a different external port would publish an
      // address that does not match the one on the card. The gateway may still
      // assign another — that is recorded and surfaced, not silently accepted.
      internalPort: inputs.publicPort,
      externalPort: inputs.publicPort,
      internalIp: inputs.lanAddress,
    },
  };
};
