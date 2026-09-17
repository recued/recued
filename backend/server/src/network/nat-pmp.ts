/** D-273 P1 — NAT-PMP (RFC 6886) client: request, renew and delete a port
 *  mapping on the default-route gateway.
 *
 *  🔑 CHOSEN FIRST BECAUSE IT IS SMALL. NAT-PMP is fixed-layout binary UDP to a
 *  known address — no SSDP multicast, no XML device description, no SOAP. That
 *  makes it the surface on which to settle D-273's security question before
 *  committing to UPnP IGD, which is several times the code for the same
 *  capability with wider router coverage.
 *
 *  ⚠ NAT-PMP ONLY, NOT PCP. PCP (RFC 6887) is protocol version 2 with a
 *  different, larger packet; a PCP-only gateway answers a version-0 request with
 *  `unsupported_version`, which this surfaces by name so the caller can say so
 *  rather than reporting a dead router. Adding PCP is a second encoder behind
 *  the same client shape.
 *
 *  ⛔ NO ENUMERATION EXISTS IN THIS PROTOCOL. There is no "list mappings"
 *  operation — only assert (with a lifetime) and delete (lifetime 0). That is
 *  why D-273 makes the LOCAL RECORD the authority for what we created, rather
 *  than the router's view: the router cannot be asked, and even where it can
 *  (IGD), "mapped to this machine" is not "mapped BY us". */

import { createSocket } from 'node:dgram';

/** The gateway's NAT-PMP port. Fixed by RFC 6886 § 3.2. */
export const NAT_PMP_PORT = 5351;

const VERSION = 0;
/** RFC 6886 § 3.2/3.3. The response opcode is the request opcode + 128. */
const OP_EXTERNAL_ADDRESS = 0;
const OP_MAP_UDP = 1;
const OP_MAP_TCP = 2;
const RESPONSE_BIT = 128;

export type NatPmpProtocol = 'tcp' | 'udp';

/** RFC 6886 § 3.5. ⚠ `not_authorized` is THE actionable one — it means the
 *  gateway speaks NAT-PMP and the owner has the feature switched OFF, which is a
 *  different message from "your router cannot do this". */
export const NAT_PMP_RESULT_CODES = {
  0: 'success',
  1: 'unsupported_version',
  2: 'not_authorized',
  3: 'network_failure',
  4: 'out_of_resources',
  5: 'unsupported_opcode',
} as const;

export type NatPmpResultCode =
  (typeof NAT_PMP_RESULT_CODES)[keyof typeof NAT_PMP_RESULT_CODES] | 'unknown';

export class NatPmpError extends Error {
  constructor(readonly code: NatPmpResultCode, readonly raw: number, message: string) {
    super(message);
    this.name = 'NatPmpError';
  }
}

const resultCodeName = (raw: number): NatPmpResultCode =>
  (NAT_PMP_RESULT_CODES as Record<number, NatPmpResultCode | undefined>)[raw] ?? 'unknown';

// ── wire format ────────────────────────────────────────────────────────────

/** RFC 6886 § 3.2 — 2 bytes: version, opcode. */
export const encodeExternalAddressRequest = (): Uint8Array =>
  Uint8Array.from([VERSION, OP_EXTERNAL_ADDRESS]);

/** RFC 6886 § 3.3 — 12 bytes:
 *  `version | opcode | reserved(2) | internal port(2) | external port(2) | lifetime(4)`
 *
 *  ⚠ A LIFETIME OF ZERO IS THE DELETE OPERATION, not a zero-length mapping, and
 *  RFC 6886 § 3.4 also requires the suggested external port to be 0 when
 *  deleting. Encoding that rule here rather than at the call site means a caller
 *  cannot half-delete by passing a lifetime of 0 with a port still set. */
export const encodeMapRequest = (args: {
  protocol: NatPmpProtocol;
  internalPort: number;
  externalPort: number;
  lifetimeSeconds: number;
}): Uint8Array => {
  const buf = new Uint8Array(12);
  const view = new DataView(buf.buffer);
  const deleting = args.lifetimeSeconds === 0;
  buf[0] = VERSION;
  buf[1] = args.protocol === 'tcp' ? OP_MAP_TCP : OP_MAP_UDP;
  view.setUint16(2, 0, false); // reserved
  view.setUint16(4, args.internalPort, false);
  view.setUint16(6, deleting ? 0 : args.externalPort, false);
  view.setUint32(8, args.lifetimeSeconds, false);
  return buf;
};

export interface NatPmpExternalAddress {
  /** The gateway's WAN address. ⚠ A `100.64/10` value here is CGNAT: the
   *  mapping will succeed and the address still will not be reachable. */
  externalIp: string;
  /** RFC 6886 § 3.2 — seconds since the gateway's port-mapping state was reset.
   *  ⛔ A value LOWER than one previously seen means the gateway rebooted and
   *  LOST every mapping, including ours, while still answering normally. It is
   *  the only in-band signal that a silent re-map is needed. */
  epochSeconds: number;
}

const assertResponseShape = (
  msg: Uint8Array,
  expectedOpcode: number,
  minLength: number,
): DataView => {
  if (msg.length < minLength) {
    throw new NatPmpError('unknown', -1, `nat-pmp: short response (${String(msg.length)} bytes)`);
  }
  if (msg[0] !== VERSION) {
    throw new NatPmpError(
      'unsupported_version', -1, `nat-pmp: response version ${String(msg[0])}`,
    );
  }
  // ⛔ MATCHED, NOT ASSUMED. A gateway also sends UNSOLICITED multicast
  // announcements when its external address changes (RFC 6886 § 3.2.1), and a
  // socket can pick up a stray datagram. Accepting any packet that arrives would
  // read an announcement as the answer to whatever we just asked.
  if (msg[1] !== expectedOpcode + RESPONSE_BIT) {
    throw new NatPmpError(
      'unknown', -1,
      `nat-pmp: opcode ${String(msg[1])} is not a response to ${String(expectedOpcode)}`,
    );
  }
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const raw = view.getUint16(2, false);
  if (raw !== 0) {
    throw new NatPmpError(resultCodeName(raw), raw, `nat-pmp: ${resultCodeName(raw)}`);
  }
  return view;
};

export const decodeExternalAddressResponse = (msg: Uint8Array): NatPmpExternalAddress => {
  const view = assertResponseShape(msg, OP_EXTERNAL_ADDRESS, 12);
  return {
    epochSeconds: view.getUint32(4, false),
    externalIp: [msg[8], msg[9], msg[10], msg[11]].map((b) => String(b)).join('.'),
  };
};

export interface NatPmpMappingResult {
  internalPort: number;
  /** ⛔ WHAT THE GATEWAY ASSIGNED, WHICH MAY NOT BE WHAT WE ASKED FOR. RFC 6886
   *  § 3.3 lets it pick a different external port when the suggestion is taken.
   *  A caller that assumes its own number is what got mapped will publish an
   *  address nobody can reach. */
  externalPort: number;
  /** ⛔ THE LIFETIME GRANTED, WHICH MAY BE SHORTER THAN REQUESTED. Renewal has to
   *  be timed off this, not off what we asked for, or the mapping lapses between
   *  refreshes while every log line says it was renewed. */
  lifetimeSeconds: number;
  epochSeconds: number;
}

export const decodeMapResponse = (
  msg: Uint8Array,
  protocol: NatPmpProtocol,
): NatPmpMappingResult => {
  const opcode = protocol === 'tcp' ? OP_MAP_TCP : OP_MAP_UDP;
  const view = assertResponseShape(msg, opcode, 16);
  return {
    epochSeconds: view.getUint32(4, false),
    internalPort: view.getUint16(8, false),
    externalPort: view.getUint16(10, false),
    lifetimeSeconds: view.getUint32(12, false),
  };
};

// ── transport ──────────────────────────────────────────────────────────────

/** One send, one awaited reply. The retry policy sits ABOVE this so it can be
 *  tested without a socket, and so a caller that wants a different policy (boot
 *  reconcile vs a button press) does not have to reimplement the transport. */
export type NatPmpSend = (
  payload: Uint8Array,
  opts: { gateway: string; timeoutMs: number },
) => Promise<Uint8Array>;

/** RFC 6886 § 3.1 prescribes 250 ms doubling over NINE retries — roughly two
 *  minutes. ⚠ DELIBERATELY NOT FOLLOWED. That budget is written for a client
 *  that must not give up; ours runs behind a person waiting on a screen, or at
 *  boot where a slow answer delays nothing that matters. Three attempts bound it
 *  at ~1.75 s, and a gateway that has not answered by then is reported as
 *  unreachable rather than kept waiting for. */
export const NAT_PMP_ATTEMPT_TIMEOUTS_MS: ReadonlyArray<number> = [250, 500, 1000];

export const createNatPmpSend = (): NatPmpSend =>
  async (payload, { gateway, timeoutMs }) =>
    new Promise<Uint8Array>((resolve, reject) => {
      const socket = createSocket('udp4');
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closing */ }
        fn();
      };
      const timer = setTimeout(
        () => { done(() => { reject(new Error('nat-pmp: timeout')); }); },
        timeoutMs,
      );
      socket.on('message', (msg, rinfo) => {
        // ⚠ The gateway is the only party we asked. A reply from anywhere else
        // on the LAN is not an answer — it is someone else's traffic, or a
        // spoof, and reading it would let any host on the network dictate what
        // we believe about our own mapping.
        if (rinfo.address !== gateway) return;
        done(() => { resolve(new Uint8Array(msg)); });
      });
      socket.on('error', (err) => { done(() => { reject(err); }); });
      socket.send(payload, NAT_PMP_PORT, gateway, (err) => {
        if (err) done(() => { reject(err); });
      });
    });

export interface NatPmpClient {
  externalAddress(): Promise<NatPmpExternalAddress>;
  /** Assert a mapping. Also the RENEW operation — re-asserting the same
   *  `(protocol, internalPort, externalPort)` refreshes its lease, which is what
   *  makes D-273's "request again on start" a one-line continuation rather than
   *  a special case. */
  map(args: {
    protocol: NatPmpProtocol;
    internalPort: number;
    externalPort: number;
    lifetimeSeconds: number;
  }): Promise<NatPmpMappingResult>;
  /** RFC 6886 § 3.4 — a map request with lifetime 0. */
  unmap(args: { protocol: NatPmpProtocol; internalPort: number }): Promise<void>;
}

export const createNatPmpClient = (opts: {
  gateway: string;
  send?: NatPmpSend;
  attemptTimeoutsMs?: ReadonlyArray<number>;
}): NatPmpClient => {
  const send = opts.send ?? createNatPmpSend();
  const attempts = opts.attemptTimeoutsMs ?? NAT_PMP_ATTEMPT_TIMEOUTS_MS;

  /** ⛔ A RESULT CODE IS AN ANSWER; RETRYING IT IS NOT. `not_authorized` means
   *  the owner switched the feature off — asking twice more says the same thing
   *  three times and spends the reader's wait doing it. Only transport silence
   *  is retried. */
  const transact = async (payload: Uint8Array): Promise<Uint8Array> => {
    let lastError: unknown;
    for (const timeoutMs of attempts) {
      try {
        return await send(payload, { gateway: opts.gateway, timeoutMs });
      } catch (err) {
        if (err instanceof NatPmpError) throw err;
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('nat-pmp: gateway did not answer');
  };

  return {
    async externalAddress() {
      return decodeExternalAddressResponse(await transact(encodeExternalAddressRequest()));
    },
    async map(args) {
      if (args.lifetimeSeconds <= 0) {
        // ⛔ Refused rather than forwarded. A zero lifetime IS the delete
        // operation on the wire, so letting it through `map()` would make a
        // caller that mis-computed a lease silently tear its mapping down.
        throw new Error('nat-pmp: map() needs a positive lifetime; use unmap() to delete');
      }
      const result = decodeMapResponse(await transact(encodeMapRequest(args)), args.protocol);
      if (result.internalPort !== args.internalPort) {
        throw new NatPmpError(
          'unknown', -1,
          `nat-pmp: response is for internal port ${String(result.internalPort)}, `
          + `not ${String(args.internalPort)}`,
        );
      }
      return result;
    },
    async unmap(args) {
      decodeMapResponse(
        await transact(encodeMapRequest({
          protocol: args.protocol,
          internalPort: args.internalPort,
          externalPort: 0,
          lifetimeSeconds: 0,
        })),
        args.protocol,
      );
    },
  };
};
