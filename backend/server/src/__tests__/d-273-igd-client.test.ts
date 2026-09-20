/** D-273 P2 slice 3 — the IGD client. */

import { describe, expect, it } from 'vitest';
import {
  createIgdClient,
  IgdPermanentLeaseRefused,
  type IgdHttpPost,
} from '../network/igd-client.js';

const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1' as const;

const fault = (code: number): string =>
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>'
  + '<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">'
  + `<errorCode>${String(code)}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;

const mk = (post: IgdHttpPost) => createIgdClient({
  controlUrl: 'http://192.168.1.1:5000/ctl/IPConn',
  serviceType: SERVICE,
  post,
  internalClient: '192.168.1.42',
});

describe('D-273 — the 725 refusal', () => {
  it('⛔⛔ REFUSES a router that only accepts PERMANENT mappings', async () => {
    // The documented workaround is to resend with NewLeaseDuration 0 — a
    // permanent mapping. D-273 rests on the lease being the only thing that
    // closes this port, because nothing releases on shutdown; a permanent
    // mapping silently converts "it expires on its own" into "open until
    // someone notices".
    const sent: string[] = [];
    const client = mk(async ({ body }) => { sent.push(body); return fault(725); });
    await expect(client.map({
      protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds: 600,
    })).rejects.toBeInstanceOf(IgdPermanentLeaseRefused);

    // ⛔ AND IT DOES NOT RETRY WITH A ZERO LEASE. One request, then a refusal —
    // the workaround being easy is exactly why the refusal has to be explicit.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('<NewLeaseDuration>600</NewLeaseDuration>');
  });

  it('⚠ the message tells the owner what to do instead', async () => {
    const client = mk(async () => fault(725));
    await expect(client.map({
      protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds: 600,
    })).rejects.toThrow(/Forward the port yourself/);
  });

  it('⛔ and a zero lease is refused before it reaches the router', async () => {
    // Zero IS permanent in IGD, so a miscomputed lease would create exactly the
    // mapping the refusal exists to prevent.
    let called = false;
    const client = mk(async () => { called = true; return ''; });
    await expect(client.map({
      protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds: 0,
    })).rejects.toThrow(/positive lifetime/);
    expect(called).toBe(false);
  });
});

describe('D-273 — enumeration', () => {
  const ENTRY = '<s:Envelope><s:Body><u:GetSpecificPortMappingEntryResponse>'
    + '<NewInternalPort>443</NewInternalPort>'
    + '<NewInternalClient>192.168.1.42</NewInternalClient>'
    + '<NewEnabled>1</NewEnabled>'
    + '<NewPortMappingDescription>Recued</NewPortMappingDescription>'
    + '<NewLeaseDuration>600</NewLeaseDuration>'
    + '</u:GetSpecificPortMappingEntryResponse></s:Body></s:Envelope>';

  it('reads the entry a router reports', async () => {
    const client = mk(async () => ENTRY);
    expect(await client.getMapping({ protocol: 'tcp', externalPort: 443 })).toEqual({
      internalClient: '192.168.1.42', internalPort: 443, enabled: true,
      leaseSeconds: 600, description: 'Recued',
    });
  });

  it('⛔⛔ 714 is NULL — "nothing is mapped there" is the ANSWER', async () => {
    // Treating it as a failure makes the only thing IGD adds over NAT-PMP
    // unusable, and it is what tells the owner's hand-made forward from ours.
    const client = mk(async () => fault(714));
    expect(await client.getMapping({ protocol: 'tcp', externalPort: 443 })).toBeNull();
  });

  it.each([
    ['1', true], ['true', true], ['TRUE', true],
    ['0', false], ['false', false], ['', false],
  ])('⚠ `NewEnabled` of %s reads as %s — vendors send both spellings', async (raw, expected) => {
    // A parser that only understood `1`/`0` would read every `true` router's
    // live mapping as switched off, and then remap over a working entry.
    const client = mk(async () => ENTRY.replace(
      '<NewEnabled>1</NewEnabled>', `<NewEnabled>${raw}</NewEnabled>`,
    ));
    const got = await client.getMapping({ protocol: 'tcp', externalPort: 443 });
    expect(got?.enabled).toBe(expected);
  });

  it('⚠ any OTHER error still throws — a broken router is not an empty table', async () => {
    const client = mk(async () => fault(501));
    await expect(client.getMapping({ protocol: 'tcp', externalPort: 443 })).rejects.toThrow();
  });
});

describe('D-273 — delete', () => {
  it('⚠ deleting something that is not there is a NO-OP, not a failure', async () => {
    // The ordinary case after a router reboot.
    const client = mk(async () => fault(714));
    await expect(client.unmap({ protocol: 'tcp', internalPort: 443, externalPort: 443 }))
      .resolves.toBeUndefined();
  });

  it('a real failure still throws', async () => {
    const client = mk(async () => fault(501));
    await expect(client.unmap({ protocol: 'tcp', internalPort: 443, externalPort: 443 }))
      .rejects.toThrow();
  });
});

describe('D-273 — AddPortMapping shape', () => {
  it('sends the wildcard remote host, our internal client, and the lease', async () => {
    let body = '';
    // ⚠ A REALISTIC REPLY. `'<ok/>'` used to pass, because the parser returned on
    // the mere ABSENCE of a fault — which is how an HTML 503 page became a
    // successful mapping (audit P2-11). The fixture has to be a SOAP envelope
    // now, which is the point.
    const client = mk(async (args) => { body = args.body; return '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:AddPortMappingResponse/></s:Body></s:Envelope>'; });
    const result = await client.map({
      protocol: 'tcp', internalPort: 443, externalPort: 8446, lifetimeSeconds: 600,
    });
    expect(body).toContain('<NewRemoteHost></NewRemoteHost>');
    expect(body).toContain('<NewInternalClient>192.168.1.42</NewInternalClient>');
    expect(body).toContain('<NewLeaseDuration>600</NewLeaseDuration>');
    expect(body).toContain('<NewEnabled>1</NewEnabled>');
    // ⚠ IGD cannot assign a different external port, unlike NAT-PMP — so what we
    // asked for is what we got, and the shape still mirrors the NAT-PMP client
    // so both satisfy one actuator.
    expect(result).toEqual({ externalPort: 8446, lifetimeSeconds: 600 });
  });
});

/** D-273 — what actually goes on the wire, and what comes back.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18). Six properties survived, and two of them
 *  for the same reason the unmap external-port bug survived before it: every
 *  fixture in this file uses `internalPort: 443, externalPort: 443` and
 *  `protocol: 'tcp'`, so the two ports and the two protocols are
 *  indistinguishable in every request the suite has ever inspected. */
describe('D-273 — AddPortMapping puts each value in its own slot', () => {
  const okEnvelope =
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>'
    + '<u:AddPortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/>'
    + '</s:Body></s:Envelope>';

  it('⛔⛔ the INTERNAL and EXTERNAL ports do not swap', async () => {
    // ⛔ A router assigning a port we did not ask for is the whole reason the
    // record exists; a client that cannot keep the two apart in the REQUEST
    // creates the mapping on the wrong port and then records the wrong pair.
    // Invisible while every fixture maps 443→443.
    const sent: string[] = [];
    const client = mk(async ({ body }) => { sent.push(body); return okEnvelope; });
    await client.map({
      protocol: 'tcp', internalPort: 8443, externalPort: 443, lifetimeSeconds: 600,
    });
    expect(sent[0]).toContain('<NewExternalPort>443</NewExternalPort>');
    expect(sent[0]).toContain('<NewInternalPort>8443</NewInternalPort>');
  });

  it('⛔ UDP is sent as UDP', async () => {
    // Every fixture is tcp, so `PROTO` mapping udp→TCP was invisible. A UDP
    // request answered as TCP maps the wrong protocol and then reads back as
    // "nothing mapped" on the one we asked about.
    const sent: string[] = [];
    const client = mk(async ({ body }) => { sent.push(body); return okEnvelope; });
    await client.map({
      protocol: 'udp', internalPort: 8443, externalPort: 443, lifetimeSeconds: 600,
    });
    expect(sent[0]).toContain('<NewProtocol>UDP</NewProtocol>');
    expect(sent[0]).not.toContain('<NewProtocol>TCP</NewProtocol>');
  });

  it('⛔ a zero lease is refused — IGD reads it as PERMANENT', async () => {
    // Same rule as the NAT-PMP client. A miscomputed lease reaching the router
    // creates exactly the permanent mapping the 725 refusal above exists to
    // prevent, and nothing releases on shutdown.
    const client = mk(async () => okEnvelope);
    for (const lifetimeSeconds of [0, -1]) {
      await expect(
        client.map({ protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds }),
        `a lease of ${lifetimeSeconds} was sent`,
      ).rejects.toThrow(/positive lifetime/);
    }
  });

  it('⛔ only 725 becomes a permanent-lease refusal', async () => {
    // The refusal carries a specific, actionable message. Reporting every SOAP
    // fault as "your router only does permanent leases" sends the owner to a
    // setting that is not the problem.
    const client = mk(async () => fault(718)); // ConflictInMappingEntry
    const err = await client.map({
      protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds: 600,
    }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(IgdPermanentLeaseRefused);
  });
});

describe('D-273 — GetExternalIPAddress must actually carry an address', () => {
  const withIp = (inner: string): string =>
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>'
    + '<u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">'
    + inner
    + '</u:GetExternalIPAddressResponse></s:Body></s:Envelope>';

  it('⛔⛔ a reply with NO address is refused, not coalesced to empty', async () => {
    // ⛔ A DOCUMENTED PAST BUG WITH NO TEST. This coalesced to `''`, and
    // `detectPortMappingSupport` reads "the gateway answered" as `enabled` — so
    // a reply carrying no address at all reported a working, UPnP-capable
    // router. Worse, `isCgnatIpv4('')` is false, so it also CLEARED the CGNAT
    // warning it had no basis to clear: the one answer that makes the whole
    // feature pointless, silently withdrawn.
    const client = mk(async () => withIp(''));
    await expect(client.externalAddress()).rejects.toThrow(/no address/);
  });

  it('⛔ an EMPTY address element is refused too', async () => {
    // Absent and present-but-empty are different inputs and only one of them
    // was covered by the null check.
    const client = mk(async () => withIp('<NewExternalIPAddress></NewExternalIPAddress>'));
    await expect(client.externalAddress()).rejects.toThrow(/no address/);
  });

  it('a real address comes back verbatim', async () => {
    const client = mk(async () => withIp('<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>'));
    expect(await client.externalAddress()).toEqual({ externalIp: '203.0.113.7' });
  });
});

/** ⛔ THE CLIENT NAMES THE ACTION IT SENT, so a well-formed envelope answering
 *  something else cannot pass as a reply to ours.
 *
 *  ⚠ FOUND BY MUTATION: `parseSoapResponse(raw, action)` losing its second
 *  argument reddened nothing — the check is inside `igd-soap` and tested there,
 *  but nothing proved the CLIENT passes the action through. One rule, and the
 *  call site that arms it was the untested half.
 *
 *  ⛔ It matters most for `getMapping`, where the caller reads the answer as a
 *  fact about a port: a reply that is really an `AddPortMappingResponse` parses
 *  to an entry with an empty internal client and port 0, which reads as "some
 *  other machine holds this port" — a conflict invented out of a stray reply. */
describe('D-273 — a reply must answer the action we sent', () => {
  const responseFor = (action: string): string =>
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>'
    + `<u:${action}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/>`
    + '</s:Body></s:Envelope>';

  it('⛔⛔ getMapping refuses a reply to a DIFFERENT action', async () => {
    const client = mk(async () => responseFor('AddPortMapping'));
    await expect(
      client.getMapping({ protocol: 'tcp', externalPort: 443 }),
    ).rejects.toThrow(/GetSpecificPortMappingEntryResponse/);
  });

  it('⛔ map refuses one too', async () => {
    const client = mk(async () => responseFor('GetExternalIPAddress'));
    await expect(client.map({
      protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds: 600,
    })).rejects.toThrow(/AddPortMappingResponse/);
  });

  it('⚠ and a SELF-CLOSED reply to the right action is accepted', async () => {
    // The complement, and not a formality: real gateways send
    // `<u:AddPortMappingResponse/>` as often as the open/close pair, so a check
    // that understood only one spelling would refuse working routers — the
    // failure this guard is about, inverted.
    const client = mk(async () => responseFor('AddPortMapping'));
    await expect(client.map({
      protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds: 600,
    })).resolves.toEqual({ externalPort: 443, lifetimeSeconds: 600 });
  });
});

