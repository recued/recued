/** An emulated UPnP IGD router: a real HTTP server with a real mapping table.
 *
 *  ⛔⛔ WHY THIS EXISTS. The D-273 audit's worst finding — the ownership planner
 *  having no production caller, so enabling the feature could take over an
 *  owner's hand-made forward and disabling it could delete it — was invisible to
 *  every unit test in the tree, and those tests were green throughout. "Nothing
 *  calls this" cannot be caught by a test of the thing not being called.
 *
 *  🔑 SO THIS DRIVES THE CHAIN, NOT THE PIECES: real SSDP reply parsing, real
 *  location validation, a real HTTP fetch of a real device description, real
 *  control-URL derivation and confinement, real SOAP over a real socket, the
 *  real IGD client, the real actuator resolution, the real supervisor, and a
 *  real SQLite store. The assertions are about what the ROUTER ENDED UP HOLDING,
 *  which is the only thing an owner would notice.
 *
 *  ⚠ WHAT IS EMULATED, PRECISELY — so nobody reads this as more than it is:
 *
 *    1. THE DATAGRAM. SSDP is multicast UDP to 239.255.255.250:1900, which is
 *       hostile in CI and on a laptop with six interfaces. The transport seam
 *       returns a REAL, correctly-formatted SSDP reply string; everything that
 *       parses and validates it is production code.
 *    2. THE SOCKET ADDRESS. `isPlausibleIgdLocation` refuses loopback — correctly
 *       — so the emulator ADVERTISES a private address (192.168.1.1) and the
 *       injected transports map that host to the loopback port it really listens
 *       on. The validation and confinement run against the advertised address,
 *       which is the thing under test; only the connect is redirected.
 *    3. THE ROUTER'S SEMANTICS ARE OURS. `AddPortMapping` overwrites per spec
 *       § 2.4.16 because that is what the finding is about; a real router that
 *       did otherwise would hide the bug rather than expose it.
 *
 *  ⇒ Nothing above the datagram is stubbed. If a future change makes the chain
 *  stop asking the router before it deletes, these tests go red.
 */
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

/** One row in the router's forwarding table, keyed by (protocol, externalPort). */
export interface RouterMapping {
  externalPort: number;
  protocol: 'TCP' | 'UDP';
  internalClient: string;
  internalPort: number;
  enabled: boolean;
  leaseSeconds: number;
  description: string;
}

export interface EmulatedRouterOptions {
  /** The address the router ADVERTISES and that everything validates against. */
  advertisedHost?: string;
  externalIp?: string;
  /** Rows present before we ever talk to it — an owner's hand-made forwards. */
  seed?: readonly RouterMapping[];
  /** ⛔ Refuse every delete, to drive the "a refused delete is not a release"
   *  path without pretending a network error. */
  refuseDelete?: boolean;
  /** Reply to AddPortMapping with a UPnPError 725 (permanent leases only). */
  permanentLeasesOnly?: boolean;
  /** Return an HTML error page instead of SOAP, for ONE action.
   *
   *  ⛔ SCOPED TO AN ACTION ON PURPOSE. A router that returns HTML for
   *  EVERYTHING fails the chain at discovery, so a test using it never reaches
   *  the mapping call and passes whatever the parser does — which is how the
   *  first draft of the P2-11 gate case was vacuous. The interesting failure is
   *  a gateway that talks properly right up until the write. */
  replyWithHtmlFor?: string;
  /** Put the mapping on a DIFFERENT external port than asked (NAT-PMP-ish
   *  behaviour some IGDs also show). */
  assignExternalPort?: number;
}

export interface EmulatedRouter {
  /** Everything the router currently forwards. The assertion surface. */
  table(): RouterMapping[];
  /** Every SOAP action received, in order — for "did it ASK before it acted". */
  actions(): string[];
  advertisedHost: string;
  /** An SSDP reply naming this router, in the real wire format. */
  ssdpReply(searchTarget: string): string;
  /** Transports that resolve the advertised host to the real listening port. */
  fetchDescription(url: string): Promise<string>;
  httpPost(args: { url: string; soapAction: string; body: string }): Promise<string>;
  close(): Promise<void>;
}

const tag = (name: string, value: string | number): string =>
  `<${name}>${String(value)}</${name}>`;

const envelope = (inner: string): string =>
  '<?xml version="1.0"?>'
  + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
  + 's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
  + `<s:Body>${inner}</s:Body></s:Envelope>`;

const fault = (code: number, description: string): string =>
  envelope(
    '<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>'
    + '<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">'
    + tag('errorCode', code) + tag('errorDescription', description)
    + '</UPnPError></detail></s:Fault>',
  );

const readArg = (body: string, name: string): string => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body);
  return m?.[1] ?? '';
};

const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1';

export const startEmulatedIgdRouter = async (
  opts: EmulatedRouterOptions = {},
): Promise<EmulatedRouter> => {
  const advertisedHost = opts.advertisedHost ?? '192.168.1.1';
  const externalIp = opts.externalIp ?? '203.0.113.7';
  const table = new Map<string, RouterMapping>();
  for (const m of opts.seed ?? []) table.set(`${m.protocol}:${String(m.externalPort)}`, { ...m });
  const actions: string[] = [];

  const description = (host: string): string =>
    '<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>'
    + '<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>'
    + '<serviceList>'
    // ⚠ A DECOY FIRST, deliberately: a description lists several services, and a
    // chain that pairs our serviceType with the first controlURL it sees would
    // talk to the wrong one. Real descriptions look like this.
    + '<service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>'
    + '<controlURL>/ctl/L3F</controlURL></service>'
    + `<service><serviceType>${SERVICE}</serviceType>`
    // ⛔ ABSOLUTE, and naming the ADVERTISED host — so the confinement check in
    // `findIgdControlTarget` is genuinely exercised rather than trivially passed
    // by a relative URL.
    + `<controlURL>http://${host}/ctl/IPConn</controlURL></service>`
    + '</serviceList></device></root>';

  const handleSoap = (action: string, body: string): { status: number; body: string } => {
    actions.push(action);
    if (opts.replyWithHtmlFor === action) {
      return { status: 503, body: '<html><body><h1>503 Service unavailable</h1></body></html>' };
    }
    if (action === 'GetExternalIPAddress') {
      return { status: 200, body: envelope(
        `<u:GetExternalIPAddressResponse xmlns:u="${SERVICE}">`
        + tag('NewExternalIPAddress', externalIp)
        + '</u:GetExternalIPAddressResponse>') };
    }
    if (action === 'GetSpecificPortMappingEntry') {
      const key = `${readArg(body, 'NewProtocol')}:${readArg(body, 'NewExternalPort')}`;
      const found = table.get(key);
      if (found === undefined) {
        // 714 NoSuchEntryInArray — how a real gateway says "nothing there".
        return { status: 500, body: fault(714, 'NoSuchEntryInArray') };
      }
      return { status: 200, body: envelope(
        `<u:GetSpecificPortMappingEntryResponse xmlns:u="${SERVICE}">`
        + tag('NewInternalPort', found.internalPort)
        + tag('NewInternalClient', found.internalClient)
        + tag('NewEnabled', found.enabled ? 1 : 0)
        + tag('NewPortMappingDescription', found.description)
        + tag('NewLeaseDuration', found.leaseSeconds)
        + '</u:GetSpecificPortMappingEntryResponse>') };
    }
    if (action === 'AddPortMapping') {
      if (opts.permanentLeasesOnly === true) {
        return { status: 500, body: fault(725, 'OnlyPermanentLeasesSupported') };
      }
      const protocol = readArg(body, 'NewProtocol') as 'TCP' | 'UDP';
      const asked = Number(readArg(body, 'NewExternalPort'));
      const externalPort = opts.assignExternalPort ?? asked;
      // ⛔⛔ OVERWRITES, PER SPEC § 2.4.16. This is the behaviour the whole
      // ownership matrix exists to avoid triggering — an emulator that refused
      // instead would hide the defect rather than expose it.
      table.set(`${protocol}:${String(externalPort)}`, {
        externalPort,
        protocol,
        internalClient: readArg(body, 'NewInternalClient'),
        internalPort: Number(readArg(body, 'NewInternalPort')),
        enabled: readArg(body, 'NewEnabled') === '1',
        leaseSeconds: Number(readArg(body, 'NewLeaseDuration')),
        description: readArg(body, 'NewPortMappingDescription'),
      });
      return { status: 200, body: envelope(
        `<u:AddPortMappingResponse xmlns:u="${SERVICE}"/>`) };
    }
    if (action === 'DeletePortMapping') {
      if (opts.refuseDelete === true) {
        return { status: 500, body: fault(730, 'PortMappingNotFound') };
      }
      table.delete(`${readArg(body, 'NewProtocol')}:${readArg(body, 'NewExternalPort')}`);
      return { status: 200, body: envelope(
        `<u:DeletePortMappingResponse xmlns:u="${SERVICE}"/>`) };
    }
    return { status: 500, body: fault(401, 'InvalidAction') };
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(description(advertisedHost));
        return;
      }
      const soapAction = String(req.headers['soapaction'] ?? '');
      const action = /#([A-Za-z]+)"?$/.exec(soapAction)?.[1] ?? '';
      const out = handleSoap(action, body);
      res.writeHead(out.status, { 'content-type': 'text/xml' });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  /** Map the ADVERTISED host onto the port we really listen on. ⚠ The only
   *  redirection in the harness, and it happens below every check under test. */
  const toLocal = (url: string): string => {
    const parsed = new URL(url);
    if (parsed.hostname !== advertisedHost) {
      throw new Error(`harness: refused a request to ${parsed.hostname} — not the router`);
    }
    parsed.hostname = '127.0.0.1';
    parsed.port = String(port);
    return parsed.toString();
  };

  return {
    advertisedHost,
    table: () => [...table.values()],
    actions: () => [...actions],
    ssdpReply: (searchTarget) =>
      'HTTP/1.1 200 OK\r\n'
      + 'CACHE-CONTROL: max-age=1800\r\n'
      + `LOCATION: http://${advertisedHost}/rootDesc.xml\r\n`
      + `ST: ${searchTarget}\r\n`
      + `USN: uuid:emulated-router::${searchTarget}\r\n\r\n`,
    fetchDescription: async (url) => {
      const res = await fetch(toLocal(url));
      return res.text();
    },
    httpPost: async ({ url, soapAction, body }) => {
      const res = await fetch(toLocal(url), {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: soapAction },
        body,
      });
      return res.text();
    },
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
};
