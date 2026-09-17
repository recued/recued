/** D-273 P0 — does this router do port mapping, and would it help?
 *
 *  🔑 THE POINT IS TO REPLACE AN INSTRUCTION WITH AN ANSWER. D-272's router step
 *  says "forward the public port" to everyone, including the owner whose router
 *  has the feature switched off (where the instruction is wrong) and the owner
 *  behind carrier-grade NAT (where it cannot work at all). Asking the gateway
 *  once turns that one sentence into the three different sentences those three
 *  owners each need.
 *
 *  ⛔ NO SECURITY DECISION HERE, BY CONSTRUCTION. This asks the gateway what it
 *  supports and for its external address; it never requests a mapping. That is
 *  why P0 lands ahead of P1's toggle — knowing is free, opening a port is not. */

import { isCgnatIpv4 } from './resolve-lan-address.js';
import { IgdSoapError } from './igd-soap.js';
import { NatPmpError } from './nat-pmp.js';

/** ⛔ THE NARROWEST THING DETECTION NEEDS, and deliberately not `NatPmpClient`.
 *  IGD is the PREFERRED protocol at runtime, so a detector typed against
 *  NAT-PMP would either not accept the client it usually gets, or accept it and
 *  classify its errors wrongly — see the IGD branch below. */
export interface PortMappingSupportProbe {
  externalAddress(): Promise<{ externalIp: string; epochSeconds?: number }>;
}

export const PORT_MAPPING_SUPPORT_KINDS = [
  /** The gateway answered and port mapping is available. */
  'enabled',
  /** The gateway answered and REFUSED — RFC 6886 § 3.5 spells this case out as
   *  "box supports mapping, but user has turned feature off". ⛔ The one
   *  actionable answer, and the one most easily lost by collapsing it into
   *  `unsupported`: this owner has a switch to flip, and that owner does not. */
  'disabled',
  /** The gateway answered with a protocol error, or never answered at all. */
  'unsupported',
  /** ⛔ WE COULD NOT ASK. Not a property of the router — a property of this host
   *  (no default-route gateway; win32 today). Kept distinct because "we did not
   *  look" and "we looked and the answer is no" are the distinction D-272 spent
   *  an entire decision on. */
  'unknown',
] as const;
export type PortMappingSupportKind = (typeof PORT_MAPPING_SUPPORT_KINDS)[number];

export interface PortMappingSupport {
  kind: PortMappingSupportKind;
  /** The gateway's WAN address, when it told us. */
  externalIp?: string;
  /** ⚠ TRUE MEANS A MAPPING WILL SUCCEED AND CHANGE NOTHING. The ISP is NATing
   *  upstream of this router, so the port it forwards is not reachable from the
   *  internet. Detecting it here saves the owner from forwarding a port, testing
   *  it, and finding no fault at either end. */
  cgnat?: boolean;
  /** RFC 6886 § 3.2 epoch, for the caller that watches it go backwards. */
  epochSeconds?: number;
  /** Free text for the log — never for a decision. */
  detail?: string;
}

/** Ask the gateway. One request, no mapping.
 *
 *  ⚠ `client` is null when this host has no gateway address to ask — the caller
 *  has that fact before it can build a client at all, so `unknown` is produced
 *  here rather than making every caller remember to special-case it. */
export const detectPortMappingSupport = async (
  client: PortMappingSupportProbe | null,
): Promise<PortMappingSupport> => {
  if (client === null) {
    return { kind: 'unknown', detail: 'no default-route gateway to ask' };
  }
  try {
    const { externalIp, epochSeconds } = await client.externalAddress();
    const cgnat = isCgnatIpv4(externalIp);
    return {
      kind: 'enabled',
      externalIp,
      ...(epochSeconds !== undefined ? { epochSeconds } : {}),
      cgnat,
      ...(cgnat
        ? { detail: 'gateway is behind carrier-grade NAT; a mapping will not be reachable' }
        : {}),
    };
  } catch (err) {
    // ⛔⛔ BOTH PROTOCOLS HAVE A "REFUSED" AND THEY ARE DIFFERENT ERRORS. IGD is
    // preferred at runtime, so understanding only NAT-PMP's would report every
    // IGD router that has UPnP switched off as `unsupported` — telling an owner
    // with a capable router that it cannot do this, and hiding the switch.
    if (err instanceof IgdSoapError) {
      return err.name_ === 'action_not_authorized'
        ? { kind: 'disabled', detail: 'gateway refused: the feature is switched off' }
        : { kind: 'unsupported', detail: `gateway answered: ${err.name_}` };
    }
    if (err instanceof NatPmpError) {
      if (err.code === 'not_authorized') {
        return { kind: 'disabled', detail: 'gateway refused: the feature is switched off' };
      }
      // ⚠ `unsupported_version` is a PCP-only gateway (RFC 6887). It is reported
      // as unsupported because NAT-PMP is what we speak — and that answer will
      // become WRONG the day P2 adds PCP, which is why the detail says which it
      // was rather than flattening every protocol error into one word.
      return { kind: 'unsupported', detail: `gateway answered: ${err.code}` };
    }
    // Silence. ⛔ Reported as unsupported rather than unknown because we DID ask
    // and the gateway declined to answer on its own port — that is a fact about
    // the router, unlike having no address to ask at all.
    return {
      kind: 'unsupported',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
};
