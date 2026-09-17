import { igdDeviceHost } from './igd-discovery.js';

/** D-273 P2 — UPnP IGD: device description + SOAP, with no XML dependency.
 *
 *  ⚠ THIS IS NOT AN XML PARSER AND MUST NOT BECOME ONE. IGD device descriptions
 *  and SOAP responses are flat, machine-generated, and namespace-prefixed in
 *  ways that vary by vendor; what is needed is "find this tag's text" and "pair
 *  a serviceType with the controlURL in ITS OWN block". A real parser is a
 *  dependency, and this ships in a SEA binary across architectures.
 *
 *  ⛔ THE LIMIT IS STATED SO NOBODY EXTENDS IT: no attributes, no nesting beyond
 *  the one service-block split below, no CDATA, no comments. If IGD ever needs
 *  more than that, it needs a parser, not more regexes. */

/** IGD exposes the WAN connection under one of two service types depending on
 *  how the router connects upstream. ⚠ ORDER IS PREFERENCE: a device offering
 *  both is an Ethernet/DHCP WAN, where `WANIPConnection` is the live one. */
export const IGD_SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
] as const;
export type IgdServiceType = (typeof IGD_SERVICE_TYPES)[number];

/** Strip any namespace prefix from a tag name for matching: routers emit
 *  `<u:NewExternalIPAddress>`, `<NewExternalIPAddress>` and `<m:...>` for the
 *  same field, and a matcher pinned to one vendor's prefix works on that vendor
 *  only. */
const tagPattern = (name: string): RegExp =>
  new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${name}>`, 'i');

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

const decodeEntities = (text: string): string =>
  text.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);

/** First text value of `name`, or null. */
export const readTag = (xml: string, name: string): string | null => {
  const m = tagPattern(name).exec(xml);
  return m?.[1] === undefined ? null : decodeEntities(m[1].trim());
};

/** ⛔ SPLIT INTO SERVICE BLOCKS BEFORE PAIRING ANYTHING. A device description
 *  lists several services, each with its own `serviceType` and `controlURL`. A
 *  global "find serviceType, then find controlURL" would pair the type we wanted
 *  with the control URL of whichever service happened to come first — and the
 *  request would go to the right router, at the right address, and operate on
 *  the wrong service. */
const serviceBlocks = (xml: string): string[] =>
  [...xml.matchAll(/<(?:[A-Za-z0-9_.-]+:)?service>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?service>/gi)]
    .map((m) => m[1] ?? '');

export interface IgdControlTarget {
  serviceType: IgdServiceType;
  /** Absolute URL, resolved against the device description's own location. */
  controlUrl: string;
}

/** Find the WAN connection service and its control URL.
 *
 *  ⚠ `controlURL` IS ROUTINELY RELATIVE (`/ctl/IPConn`), and the base it is
 *  relative to is the LOCATION the description was fetched from — not the
 *  router's root. Resolving it wrong yields a URL that looks plausible and 404s. */
export const findIgdControlTarget = (
  descriptionXml: string,
  locationUrl: string,
): IgdControlTarget | null => {
  const blocks = serviceBlocks(descriptionXml);
  for (const wanted of IGD_SERVICE_TYPES) {
    for (const block of blocks) {
      if (readTag(block, 'serviceType') !== wanted) continue;
      const control = readTag(block, 'controlURL');
      if (control === null || control.length === 0) continue;
      try {
        const resolved = new URL(control, locationUrl);
        // ⛔⛔ THE RESOLVED URL IS CHECKED, NOT JUST THE BASE. `new URL(control,
        // base)` IGNORES the base entirely when `control` is ABSOLUTE — so a
        // description fetched from a real router's address could name
        // `http://127.0.0.1:7717/private` and this returned it unexamined. The
        // description arrived over HTTP from a device found by unauthenticated
        // multicast; it is data, and every URL derived from it is too.
        //
        // ⛔ CONFINED TO THE DISCOVERED DEVICE, which is stricter than "is it
        // private": a hostile LAN peer that passes the location check must not
        // be able to aim requests at a DIFFERENT private host — the owner's NAS,
        // or this server's own LAN listener.
        //
        // ⚠ HOST, NOT HOST:PORT. Real IGDs do serve the description and the
        // control endpoint on different ports; requiring both to match would
        // refuse working routers. The device is the boundary, not the socket.
        const deviceHost = igdDeviceHost(locationUrl);
        if (deviceHost === null) return null;
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
        if (resolved.hostname !== deviceHost) return null;
        return { serviceType: wanted, controlUrl: resolved.toString() };
      } catch {
        return null;
      }
    }
  }
  return null;
};

// ── SOAP ───────────────────────────────────────────────────────────────────

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c] ?? c);

export interface SoapRequest {
  action: string;
  body: string;
  /** The `SOAPAction` header value, quoted as the spec requires. */
  soapAction: string;
}

/** Build a SOAP 1.1 envelope for an IGD action.
 *
 *  ⚠ ARGUMENT ORDER IS PART OF THE CONTRACT. SOAP-over-IGD is positional in
 *  practice: routers read the children in the order the spec lists them and a
 *  reordered envelope is rejected or, worse, misread. Callers pass an ordered
 *  array for that reason, not a record. */
export const buildSoapRequest = (args: {
  serviceType: IgdServiceType;
  action: string;
  params: ReadonlyArray<readonly [string, string | number]>;
}): SoapRequest => {
  const params = args.params
    .map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`)
    .join('');
  return {
    action: args.action,
    soapAction: `"${args.serviceType}#${args.action}"`,
    body:
      '<?xml version="1.0"?>'
      + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"'
      + ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
      + '<s:Body>'
      + `<u:${args.action} xmlns:u="${args.serviceType}">${params}</u:${args.action}>`
      + '</s:Body></s:Envelope>',
  };
};

/** UPnP IGD error codes worth naming. The rest surface as their number.
 *
 *  ⛔ 714 IS AN ANSWER, NOT A FAILURE. `GetSpecificPortMappingEntry` returns it
 *  to mean "nothing is mapped on that port" — which is precisely the question
 *  D-273 needs enumeration for, so treating it as an error would make the only
 *  thing IGD adds over NAT-PMP unusable.
 *
 *  ⛔⛔ 725 BREAKS D-273'S SECURITY MODEL AND MUST NOT BE SWALLOWED. It means the
 *  router accepts PERMANENT mappings only — no lease. D-273 leans on the lease
 *  as the sole bound on the hole, because nothing releases on shutdown; a
 *  permanent mapping never expires, so on such a router "it expires on its own"
 *  is false and the owner has to be told. */
export const IGD_ERROR_CODES = {
  401: 'invalid_action',
  402: 'invalid_args',
  501: 'action_failed',
  606: 'action_not_authorized',
  714: 'no_such_entry',
  715: 'wildcard_source_ip_not_permitted',
  716: 'wildcard_external_port_not_permitted',
  718: 'conflict_in_mapping_entry',
  724: 'same_port_values_required',
  725: 'only_permanent_leases_supported',
  726: 'remote_host_only_supports_wildcard',
  727: 'external_port_only_supports_wildcard',
} as const;

export type IgdErrorName =
  (typeof IGD_ERROR_CODES)[keyof typeof IGD_ERROR_CODES]
  | 'unknown'
  /** ⚠ NOT ROUTER ERRORS — TRANSPORT ONES. The gateway did not refuse; what
   *  came back was not a SOAP reply to our action at all (an HTML error page, a
   *  bare fault, an answer to a different call, a missing address). Named
   *  separately so a caller can tell "the router said no" from "something
   *  answered and it was not the router". */
  | 'malformed_response' | 'soap_fault' | 'unexpected_response';

export class IgdSoapError extends Error {
  constructor(readonly code: number, readonly name_: IgdErrorName, message: string) {
    super(message);
    this.name = 'IgdSoapError';
  }
}

export const igdErrorName = (code: number): IgdErrorName =>
  (IGD_ERROR_CODES as Record<number, IgdErrorName | undefined>)[code] ?? 'unknown';

/** Parse a SOAP response, raising `IgdSoapError` on a fault.
 *
 *  ⚠ A FAULT CAN ARRIVE WITH ANY HTTP STATUS. Routers return 500 for faults,
 *  and some return 200 — so the body is the authority, not the status line, and
 *  a caller that checked `res.ok` first would treat half the fleet's refusals as
 *  successes. */
export const parseSoapResponse = (xml: string, expectedAction?: string): string => {
  const fault = readTag(xml, 'UPnPError');
  if (fault !== null) {
    const raw = Number(readTag(fault, 'errorCode') ?? NaN);
    const code = Number.isInteger(raw) ? raw : -1;
    throw new IgdSoapError(
      code,
      igdErrorName(code),
      `igd: ${igdErrorName(code)} (${String(code)})`
      + (readTag(fault, 'errorDescription') !== null
        ? `: ${readTag(fault, 'errorDescription') ?? ''}`
        : ''),
    );
  }
  // ⛔⛔ THE ABSENCE OF A FAULT IS NOT A SUCCESS, AND THIS USED TO RETURN ON IT.
  // Combined with a transport that discards the HTTP status, an HTML "503
  // Service unavailable" page, a proxy's 404, or an empty body all parsed as a
  // successful AddPortMapping — and were persisted as a `mapped` record with a
  // lease that never existed. The router then forwards nothing while every
  // surface says the port is open.
  //
  // ⇒ A SOAP reply must LOOK LIKE ONE. `Envelope` + `Body` is the cheapest
  // structural claim that no HTML error page can make by accident.
  if (readTag(xml, 'Envelope') === null || readTag(xml, 'Body') === null) {
    throw new IgdSoapError(-1, 'malformed_response',
      'igd: reply is not a SOAP envelope');
  }
  // ⚠ A generic SOAP Fault WITHOUT a UPnPError body is still a refusal. The
  // check above only catches the UPnP-shaped ones.
  if (readTag(xml, 'Fault') !== null) {
    throw new IgdSoapError(-1, 'soap_fault', 'igd: the gateway returned a SOAP fault');
  }
  // ⚠ AND IT MUST BE A REPLY TO THE ACTION WE SENT. A well-formed envelope
  // answering a different action is not evidence about ours.
  // ⚠ ANCHORED ON THE TAG OPEN, not on `readTag`, which needs an open/close
  // PAIR. Real gateways send `<u:AddPortMappingResponse/>` self-closed as often
  // as not, and a check that only understood one spelling would refuse working
  // routers — the failure mode this whole finding is about, inverted.
  const answersOurAction = expectedAction !== undefined
    && new RegExp(`<(?:[\\w-]+:)?${expectedAction}Response[\\s/>]`).test(xml);
  if (expectedAction !== undefined && !answersOurAction) {
    throw new IgdSoapError(-1, 'unexpected_response',
      `igd: reply is not a ${expectedAction}Response`);
  }
  return xml;
};
