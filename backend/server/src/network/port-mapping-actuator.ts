/** D-273 P3 slice 1 — pick a protocol and build an actuator.
 *
 *  ⛔⛔ THE RUNTIME PREFERENCE IS THE OPPOSITE OF THE BUILD ORDER, AND BOTH ARE
 *  RIGHT. NAT-PMP was built first because it is a fifth of the code and settles
 *  the security question on a small surface. At RUNTIME, IGD is preferred —
 *  because it can ENUMERATE, and that is not a nicety: without it a client must
 *  delete a mapping it merely BELIEVES is its own, and if the router rebooted
 *  and another host has taken that port, the delete takes theirs. Choosing the
 *  smaller protocol at runtime would trade that safety for a round trip.
 *
 *  ⚠ NAT-PMP REMAINS THE FALLBACK, not a legacy path: plenty of routers speak it
 *  and not IGD, and it needs no multicast — which matters on networks where SSDP
 *  is filtered. */

import { createIgdClient, type IgdHttpPost, type IgdMappingEntry } from './igd-client.js';
import { createSocket } from 'node:dgram';

import {
  discoverIgd,
  SSDP_MULTICAST_ADDRESS,
  SSDP_PORT,
  type SsdpTransport,
} from './igd-discovery.js';
import { findIgdControlTarget } from './igd-soap.js';
import { createNatPmpClient, type NatPmpSend } from './nat-pmp.js';
import type { PortMappingActuator } from './port-mapping-plan.js';

export type PortMappingProtocol = 'igd' | 'nat-pmp';

export interface ResolvedActuator {
  protocol: PortMappingProtocol;
  actuator: PortMappingActuator;
  externalAddress(): Promise<{ externalIp: string }>;
  /** ⛔ ONLY IGD CAN ANSWER THIS. `null` means the protocol in use cannot be
   *  asked — which is a different thing from "nothing is mapped there", and a
   *  caller that confused them would treat every NAT-PMP router as having an
   *  empty forwarding table and act on the boot matrix's `map` branch every
   *  time. */
  getMapping:
    | ((args: { protocol: 'tcp' | 'udp'; externalPort: number }) => Promise<IgdMappingEntry | null>)
    | null;
}

export interface ResolveActuatorOptions {
  gateway: string | undefined;
  /** This machine's LAN address — the mapping's destination, and the interface
   *  SSDP must leave by. */
  lanAddress: string;
  ssdp?: SsdpTransport;
  httpPost?: IgdHttpPost;
  /** Fetches the device description named by an SSDP reply's LOCATION. */
  fetchDescription?: (url: string) => Promise<string>;
  natPmpSend?: NatPmpSend;
}

/** Find something that can map a port, preferring IGD.
 *
 *  ⚠ Every step degrades rather than throwing: a network with no IGD, a router
 *  whose description does not parse, or a missing gateway each fall through to
 *  the next option and finally to `null`. A port-mapping feature that threw on
 *  a quiet network would take the boot with it. */
export const resolvePortMappingActuator = async (
  opts: ResolveActuatorOptions,
): Promise<ResolvedActuator | null> => {
  if (opts.ssdp !== undefined && opts.fetchDescription !== undefined) {
    try {
      const found = await discoverIgd({
        transport: opts.ssdp,
        bindAddress: opts.lanAddress,
      });
      if (found !== null) {
        const description = await opts.fetchDescription(found.location);
        const target = findIgdControlTarget(description, found.location);
        if (target !== null && opts.httpPost !== undefined) {
          const igd = createIgdClient({
            controlUrl: target.controlUrl,
            serviceType: target.serviceType,
            post: opts.httpPost,
            internalClient: opts.lanAddress,
          });
          return {
            protocol: 'igd',
            // ⚠ The actuator shape hides the difference; `getMapping` is where
            // it deliberately does NOT, because the caller's behaviour must
            // change when enumeration is unavailable.
            actuator: {
              map: (a) => igd.map(a),
              // ⛔⛔ THE EXTERNAL PORT, AS THE CALLER NAMES IT. This used to pass
              // `externalPort: a.internalPort` — fine while the two agree, and
              // wrong the moment a router assigns a port we did not ask for,
              // which is exactly when the record matters. IGD's
              // DeletePortMapping keys on (remote host, EXTERNAL port,
              // protocol), so the substitution deleted a different entry, or
              // nothing, and left ours open.
              unmap: (a) => igd.unmap(a),
            },
            externalAddress: () => igd.externalAddress(),
            getMapping: (a) => igd.getMapping(a),
          };
        }
      }
    } catch {
      // Discovery is best-effort; fall through to NAT-PMP.
    }
  }

  // ⚠ TRIMMED, like `resolveLanAddress` already trims the same value. Both read
  // a gateway out of the routing table, and `'   '` passed `length > 0` here
  // while being rejected there — so a whitespace-only read built a NAT-PMP
  // client aimed at nowhere and reported a mapping failure the operator cannot
  // act on, instead of the honest "no router found" that `null` means.
  const gateway = opts.gateway?.trim() ?? '';
  if (gateway.length > 0) {
    const client = createNatPmpClient({
      gateway,
      ...(opts.natPmpSend !== undefined ? { send: opts.natPmpSend } : {}),
    });
    return {
      protocol: 'nat-pmp',
      actuator: {
        map: (a) => client.map(a),
        unmap: (a) => client.unmap(a),
      },
      externalAddress: async () => ({
        externalIp: (await client.externalAddress()).externalIp,
      }),
      // ⛔ NULL, NOT AN EMPTY RESULT. NAT-PMP has no enumeration; reporting "no
      // mapping" would tell the boot matrix the port is free on every router
      // that speaks only this protocol.
      getMapping: null,
    };
  }

  return null;
};

// ── real transports ────────────────────────────────────────────────────────


/** ⛔ A DEVICE DESCRIPTION IS FETCHED FROM AN ADDRESS A LAN PEER CHOSE, so both
 *  bounds here are load-bearing rather than tidiness: without the size cap a
 *  hostile or broken device can stream until this process runs out of memory,
 *  and without the timeout it can simply never finish. `isPlausibleIgdLocation`
 *  bounds WHERE we will look; these bound what looking can cost. */
export const IGD_DESCRIPTION_MAX_BYTES = 256 * 1024;
export const IGD_HTTP_TIMEOUT_MS = 5000;

const withTimeout = async <T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

/** Read a reply, refusing one that is too big — WHILE it arrives.
 *
 *  ⛔⛔ THIS USED TO BUFFER THE WHOLE BODY AND *THEN* MEASURE IT. `await
 *  res.text()` completes the download first, so the advertised 256 KiB cap
 *  bounded nothing: a hostile LAN responder could make us allocate a body of any
 *  size, and only the five-second timeout limited it at all. ⚠ And detection
 *  runs with mapping switched OFF, so that was reachable on any server with a
 *  gateway, not only on one using the feature.
 *
 *  ⚠ BYTES, NOT CHARACTERS. `text.length` counts UTF-16 code units, so a
 *  multi-byte body was measured smaller than it is — the cap read as generous by
 *  up to 3× exactly where the content is attacker-chosen.
 *
 *  ⚠ AND THE STREAM IS CANCELLED on refusal, rather than left to drain. */
const readCapped = async (res: Response): Promise<string> => {
  const body = res.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > IGD_DESCRIPTION_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('igd: device description is implausibly large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { joined.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(joined);
};

export const createIgdDescriptionFetch = (
  /** ⚠ Seamed for the size-cap tests only. Production omits it — a description
   *  fetch exercised solely through a stub proves the stub. */
  fetchImpl: typeof fetch = fetch,
): ((url: string) => Promise<string>) =>
  (url) => withTimeout(
    async (signal) => readCapped(await fetchImpl(url, { signal, redirect: 'error' })),
    IGD_HTTP_TIMEOUT_MS,
  );

export const createIgdHttpPost = (
  /** ⚠ Seamed exactly as `createIgdDescriptionFetch` is, and for the same
   *  reason: the redirect confinement below is an SSRF boundary, and the
   *  description fetch's identical guard is tested while this one was not — one
   *  rule at two ends with only one end pinned. Production omits it. */
  fetchImpl: typeof fetch = fetch,
): IgdHttpPost =>
  ({ url, soapAction, body }) => withTimeout(
    async (signal) => readCapped(await fetchImpl(url, {
      method: 'POST',
      // ⚠ Both headers are required by the SOAP binding, and `SOAPAction` must
      // arrive already quoted — `buildSoapRequest` does that.
      headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: soapAction },
      body,
      signal,
      // ⛔ A control URL that redirects is not a router doing its job; following
      // one would let a LAN peer bounce this request anywhere.
      redirect: 'error',
    })),
    IGD_HTTP_TIMEOUT_MS,
  );

/** SSDP over UDP multicast.
 *
 *  ⚠ COLLECTS FOR THE WHOLE WINDOW RATHER THAN RESOLVING ON THE FIRST REPLY.
 *  Devices spread their answers randomly across MX to avoid a stampede, so the
 *  first arrival is not the only one and is not necessarily the router — a
 *  printer or a media server answering `ssdp:all` can be quicker. */
/** The slice of a UDP socket this transport actually uses.
 *
 *  ⚠ DECLARED SO THE TRANSPORT CAN BE DRIVEN. Every property below — pinning
 *  the multicast interface, collecting for the whole window, treating a socket
 *  error as an answer, settling once, and closing on every exit — was written
 *  with a documented reason and NONE was reachable from a test while this
 *  function reached for `node:dgram` itself. Same seam, same rationale, as the
 *  `fetchImpl` parameters on the two fetch helpers above and `send` on
 *  `createNatPmpClient`. */
export interface SsdpSocket {
  on(event: 'message', listener: (msg: { toString(encoding: 'utf8'): string }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  bind(options: { address?: string }, callback: () => void): unknown;
  setMulticastInterface(address: string): void;
  send(
    message: string,
    port: number,
    address: string,
    callback: (err: Error | null) => void,
  ): void;
  close(): void;
}

export type SsdpSocketFactory = () => SsdpSocket;

/** ⚠ The one cast, contained here: `node:dgram`'s `Socket` satisfies the shape
 *  above but its overloaded `on` does not line up structurally. */
const defaultSsdpSocket: SsdpSocketFactory = () =>
  createSocket({ type: 'udp4', reuseAddr: true }) as unknown as SsdpSocket;

export const createSsdpTransport = (
  createSsdpSocket: SsdpSocketFactory = defaultSsdpSocket,
): SsdpTransport => ({
  search: ({ message, windowMs, bindAddress }) =>
    new Promise<ReadonlyArray<string>>((resolve) => {
      const replies: string[] = [];
      const socket = createSsdpSocket();
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closing */ }
        resolve(replies);
      };
      const timer = setTimeout(finish, windowMs);
      socket.on('message', (msg) => { replies.push(msg.toString('utf8')); });
      // ⚠ Silence is an answer here, not a failure: a network with no IGD is the
      // ordinary case, so an error resolves with what we have instead of
      // rejecting.
      socket.on('error', finish);
      socket.bind(bindAddress === undefined ? {} : { address: bindAddress }, () => {
        try {
          // ⛔ THE INTERFACE CHOICE IS THIS CALL. Binding alone does not decide
          // which interface multicast LEAVES by on every platform; a host with a
          // Docker bridge, a VPN and a real LAN sends it out the wrong one, and
          // the result is indistinguishable from a router with no UPnP.
          if (bindAddress !== undefined) socket.setMulticastInterface(bindAddress);
          socket.send(message, SSDP_PORT, SSDP_MULTICAST_ADDRESS, (err) => {
            if (err) finish();
          });
        } catch {
          finish();
        }
      });
    }),
});
