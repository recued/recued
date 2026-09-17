/** D-273 P2 slice 3 — the IGD client. Satisfies `PortMappingActuator`, and adds
 *  the one thing NAT-PMP cannot do: ENUMERATION.
 *
 *  🔑 ENUMERATION IS NOT A CONVENIENCE HERE, IT IS WHAT MAKES IGD SAFER. NAT-PMP
 *  can only assert or delete, so a client must act on its own record alone —
 *  which means deleting a mapping it believes is its own without ever checking.
 *  If the router rebooted and someone else has since taken that port, a blind
 *  delete takes THEIRS. `getMapping` is what lets this client look first. */

import {
  buildSoapRequest,
  IgdSoapError,
  parseSoapResponse,
  readTag,
  type IgdServiceType,
} from './igd-soap.js';

export interface IgdMappingEntry {
  /** The LAN host the router forwards to. */
  internalClient: string;
  internalPort: number;
  /** ⚠ IGD ENTRIES CARRY AN ENABLED FLAG. A mapping that exists but is switched
   *  off looks mapped to anything that only asks "is there an entry" and
   *  forwards nothing. It has to read as "not effectively mapped". */
  enabled: boolean;
  /** 0 means permanent — see the 725 refusal below. */
  leaseSeconds: number;
  description: string;
}

export class IgdPermanentLeaseRefused extends Error {
  constructor() {
    super(
      'igd: this router only accepts permanent port mappings. Recued will not '
      + 'create one, because a permanent mapping never expires and Recued does '
      + 'not take mappings down on shutdown — the lease is the only thing that '
      + 'closes the port. Forward the port yourself if you want it open.',
    );
    this.name = 'IgdPermanentLeaseRefused';
  }
}

export type IgdHttpPost = (args: {
  url: string;
  soapAction: string;
  body: string;
}) => Promise<string>;

export interface IgdClient {
  externalAddress(): Promise<{ externalIp: string }>;
  map(args: {
    protocol: 'tcp' | 'udp';
    internalPort: number;
    externalPort: number;
    lifetimeSeconds: number;
  }): Promise<{ externalPort: number; lifetimeSeconds: number }>;
  unmap(args: { protocol: 'tcp' | 'udp'; internalPort: number; externalPort: number }): Promise<void>;
  /** What the router currently forwards on this external port, or `null` when
   *  nothing does. ⛔ `null` COMES FROM ERROR 714, which IGD uses as the ANSWER
   *  "no such entry" rather than as a failure. */
  getMapping(args: {
    protocol: 'tcp' | 'udp';
    externalPort: number;
  }): Promise<IgdMappingEntry | null>;
}

const PROTO = { tcp: 'TCP', udp: 'UDP' } as const;

export const createIgdClient = (opts: {
  controlUrl: string;
  serviceType: IgdServiceType;
  post: IgdHttpPost;
  /** What the router shows the owner in its own UI. Worth being recognisable:
   *  someone looking at a forwarding table should be able to tell where it came
   *  from without guessing. */
  description?: string;
  internalClient: string;
}): IgdClient => {
  const call = async (
    action: string,
    params: ReadonlyArray<readonly [string, string | number]>,
  ): Promise<string> => {
    const req = buildSoapRequest({ serviceType: opts.serviceType, action, params });
    const raw = await opts.post({
      url: opts.controlUrl,
      soapAction: req.soapAction,
      body: req.body,
    });
    // ⚠ The action is named, so a well-formed envelope answering something
    // else cannot pass as a reply to ours.
    return parseSoapResponse(raw, action);
  };

  return {
    async externalAddress() {
      const xml = await call('GetExternalIPAddress', []);
      // ⛔ AN ABSENT ADDRESS IS NOT AN EMPTY ONE. This coalesced to `''`, and
      // `detectPortMappingSupport` reads "the gateway answered" as `enabled` —
      // so a reply carrying no address at all reported a working, UPnP-capable
      // router, and `isCgnatIpv4('')` is false, so it also cleared the CGNAT
      // warning it had no basis to clear.
      const externalIp = readTag(xml, 'NewExternalIPAddress');
      if (externalIp === null || externalIp.length === 0) {
        throw new IgdSoapError(-1, 'malformed_response',
          'igd: GetExternalIPAddress returned no address');
      }
      return { externalIp };
    },

    async map(args) {
      if (args.lifetimeSeconds <= 0) {
        // ⛔ Same rule as the NAT-PMP client: a zero lease is PERMANENT in IGD,
        // which is exactly what this module refuses below. Letting a
        // miscomputed lease through would create the mapping the refusal
        // exists to prevent.
        throw new Error('igd: map() needs a positive lifetime');
      }
      try {
        await call('AddPortMapping', [
          // ⚠ Positional. Empty `NewRemoteHost` is the wildcard — "from anyone",
          // which is what a public port means.
          ['NewRemoteHost', ''],
          ['NewExternalPort', args.externalPort],
          ['NewProtocol', PROTO[args.protocol]],
          ['NewInternalPort', args.internalPort],
          ['NewInternalClient', opts.internalClient],
          ['NewEnabled', 1],
          ['NewPortMappingDescription', opts.description ?? 'Recued'],
          ['NewLeaseDuration', args.lifetimeSeconds],
        ]);
      } catch (err) {
        // ⛔⛔ REFUSED, NOT WORKED AROUND. The documented workaround for 725 is to
        // resend with `NewLeaseDuration: 0` — a PERMANENT mapping. D-273 rests
        // on the lease being the only thing that closes this port, because
        // nothing releases on shutdown; a permanent mapping silently converts
        // "it expires on its own" into "it is open until someone notices". The
        // owner is told instead.
        if (err instanceof IgdSoapError
          && err.name_ === 'only_permanent_leases_supported') {
          throw new IgdPermanentLeaseRefused();
        }
        throw err;
      }
      // ⚠ IGD's AddPortMapping returns NOTHING on success — unlike NAT-PMP, it
      // cannot assign a different external port, so what we asked for is what we
      // got. The shape still mirrors the NAT-PMP client so both satisfy one
      // actuator.
      return { externalPort: args.externalPort, lifetimeSeconds: args.lifetimeSeconds };
    },

    async unmap(args) {
      try {
        await call('DeletePortMapping', [
          ['NewRemoteHost', ''],
          ['NewExternalPort', args.externalPort],
          ['NewProtocol', PROTO[args.protocol]],
        ]);
      } catch (err) {
        // ⚠ Deleting something that is not there is a no-op, not a failure —
        // and it is the ordinary case after a router reboot.
        if (err instanceof IgdSoapError && err.name_ === 'no_such_entry') return;
        throw err;
      }
    },

    async getMapping(args) {
      try {
        const xml = await call('GetSpecificPortMappingEntry', [
          ['NewRemoteHost', ''],
          ['NewExternalPort', args.externalPort],
          ['NewProtocol', PROTO[args.protocol]],
        ]);
        return {
          internalClient: readTag(xml, 'NewInternalClient') ?? '',
          internalPort: Number(readTag(xml, 'NewInternalPort') ?? 0),
          // ⚠ Routers send `1`/`0`, and some send `true`/`false`.
          enabled: /^(1|true)$/i.test(readTag(xml, 'NewEnabled') ?? ''),
          leaseSeconds: Number(readTag(xml, 'NewLeaseDuration') ?? 0),
          description: readTag(xml, 'NewPortMappingDescription') ?? '',
        };
      } catch (err) {
        // ⛔ 714 IS THE ANSWER, NOT A FAILURE: "nothing is mapped on that port".
        if (err instanceof IgdSoapError && err.name_ === 'no_such_entry') return null;
        throw err;
      }
    },
  };
};
