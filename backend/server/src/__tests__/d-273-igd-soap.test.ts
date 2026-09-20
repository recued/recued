/** D-273 P2 — IGD device description + SOAP, against real-shaped vendor XML.
 *
 *  ⚠ The fixtures below carry the things that actually differ between routers:
 *  namespace prefixes, relative control URLs, several services in one
 *  description, and faults returned with a 200. Fixtures that were all one
 *  vendor's shape would pass against that vendor only. */

import { describe, expect, it } from 'vitest';
import {
  buildSoapRequest,
  findIgdControlTarget,
  IgdSoapError,
  parseSoapResponse,
  readTag,
} from '../network/igd-soap.js';

/** Two services before the one we want, and a RELATIVE control URL — both are
 *  the ordinary case, not a contrivance. */
const DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
 <device>
  <serviceList>
   <service>
    <serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
    <controlURL>/ctl/L3F</controlURL>
   </service>
   <service>
    <serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType>
    <controlURL>/ctl/CommonIfCfg</controlURL>
   </service>
   <service>
    <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
    <controlURL>/ctl/IPConn</controlURL>
   </service>
  </serviceList>
 </device>
</root>`;

const withControlUrl = (controlUrl: string): string => `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
 <device>
  <serviceList>
   <service>
    <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
    <controlURL>${controlUrl}</controlURL>
   </service>
  </serviceList>
 </device>
</root>`;

describe('D-273 — finding the WAN connection service', () => {
  it('⛔ refuses a control URL whose SCHEME is not http(s), even on the right host', () => {
    // ⚠ FOUND BY MUTATION. Deleting the scheme check reddened nothing, because
    // every other refusal case in this file fails the HOST comparison first —
    // and a scheme swap keeps the host intact. `ftp://192.168.1.1/x` resolved
    // against an `http://192.168.1.1:5000/...` description has a MATCHING
    // hostname, so the host guard waves it through and only the scheme guard
    // stands between the device description and an arbitrary protocol handler.
    //
    // ⛔ The description XML is attacker-influenced: it was fetched from a URL
    // named by an unauthenticated multicast datagram.
    for (const scheme of ['ftp', 'file', 'gopher', 'data', 'ws']) {
      expect(
        findIgdControlTarget(
          withControlUrl(`${scheme}://192.168.1.1:5000/ctl`),
          'http://192.168.1.1:5000/rootDesc.xml',
        ),
        `${scheme}: was accepted as a control URL`,
      ).toBeNull();
    }
  });

  it('accepts http and https on the device host — the two that are legitimate', () => {
    // The control: proves the case above rejects on SCHEME, not because an
    // absolute control URL is refused outright.
    for (const scheme of ['http', 'https']) {
      expect(findIgdControlTarget(
        withControlUrl(`${scheme}://192.168.1.1:5000/ctl`),
        'http://192.168.1.1:5000/rootDesc.xml',
      )).toEqual({
        serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
        controlUrl: `${scheme}://192.168.1.1:5000/ctl`,
      });
    }
  });

  it('⛔⛔ pairs the serviceType with the controlURL in ITS OWN block', () => {
    // A global "find serviceType, then find controlURL" pairs the type we wanted
    // with whichever control URL came first — here `/ctl/L3F`. The request would
    // go to the right router, at the right address, and operate on the wrong
    // service.
    expect(findIgdControlTarget(DESCRIPTION, 'http://192.168.1.1:5000/rootDesc.xml'))
      .toEqual({
        serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
        controlUrl: 'http://192.168.1.1:5000/ctl/IPConn',
      });
  });

  it('⛔⛔ REFUSES AN ABSOLUTE controlURL POINTING SOMEWHERE ELSE', () => {
    // 🔑 THE BUG THIS REPLACES, found by audit 2026-09-16. `new URL(control,
    // base)` IGNORES the base entirely when `control` is absolute, and the
    // result was returned unexamined — so a description fetched from a real
    // router could aim every subsequent SOAP POST at this server's own LAN
    // listener. The description arrives over HTTP from a device found by
    // unauthenticated multicast: it is data, and so is every URL derived from it.
    for (const hostile of [
      'http://127.0.0.1:7717/private',
      'http://192.168.1.99/other-device',   // private, but NOT the device we found
      'http://attacker.example/collect',
      'file:///etc/passwd',
    ]) {
      expect(
        findIgdControlTarget(
          DESCRIPTION.replace('/ctl/IPConn', hostile),
          'http://192.168.1.1:5000/rootDesc.xml',
        ),
        hostile,
      ).toBeNull();
    }
  });

  it('⚠ allows the SAME device on a DIFFERENT port — the device is the boundary', () => {
    // Real IGDs do serve the description and the control endpoint on different
    // ports. Confining to host:port would refuse working routers; confining to
    // the host still stops every redirect to another machine.
    expect(findIgdControlTarget(
      DESCRIPTION.replace('/ctl/IPConn', 'http://192.168.1.1:49152/ctl/IPConn'),
      'http://192.168.1.1:5000/rootDesc.xml',
    )?.controlUrl).toBe('http://192.168.1.1:49152/ctl/IPConn');
  });

  it('⛔ resolves a RELATIVE control URL against the description LOCATION', () => {
    // Not against the router root: a description served from a subpath makes
    // those two different, and the wrong base yields a plausible URL that 404s.
    expect(findIgdControlTarget(
      DESCRIPTION.replace('/ctl/IPConn', 'IPConn'),
      'http://192.168.1.1:5000/upnp/desc/rootDesc.xml',
    )?.controlUrl).toBe('http://192.168.1.1:5000/upnp/desc/IPConn');
  });

  it('⛔ an absolute control URL is NOT re-resolved — but must still be this device', () => {
    // ⚠⚠ THIS TEST USED TO PIN THE DEFECT. It asserted that an absolute
    // `http://10.0.0.1:8000/other` survived a description fetched from
    // `192.168.1.1:5000` — i.e. that a control URL could name a DIFFERENT
    // machine — and it was green for as long as that hole existed. The protocol
    // fact it meant to capture (absolute URLs are not resolved against the base)
    // is real and kept; the fixture's choice of a foreign host is what made it
    // an assertion about cross-device redirection.
    //
    // 🔑 A test can be correct about its subject and wrong about its fixture,
    // and then it defends the bug. The same-device case is above.
    expect(findIgdControlTarget(
      DESCRIPTION.replace('/ctl/IPConn', 'http://10.0.0.1:8000/other'),
      'http://192.168.1.1:5000/rootDesc.xml',
    )).toBeNull();
  });

  it('⚠ falls back to WANPPPConnection, and PREFERS WANIPConnection when both exist', () => {
    // A device offering both is an Ethernet/DHCP WAN, where the IP one is live.
    const pppOnly = DESCRIPTION.replace('WANIPConnection', 'WANPPPConnection');
    expect(findIgdControlTarget(pppOnly, 'http://192.168.1.1/d.xml')?.serviceType)
      .toBe('urn:schemas-upnp-org:service:WANPPPConnection:1');

    const both = DESCRIPTION.replace(
      '</serviceList>',
      '<service>'
      + '<serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType>'
      + '<controlURL>/ctl/PPP</controlURL></service></serviceList>',
    );
    expect(findIgdControlTarget(both, 'http://192.168.1.1/d.xml')?.controlUrl)
      .toBe('http://192.168.1.1/ctl/IPConn');
  });

  it('⚠ tolerates namespace prefixes, which vary by vendor', () => {
    const prefixed = DESCRIPTION
      .replace(/<service>/g, '<u:service>').replace(/<\/service>/g, '</u:service>')
      .replace(/<serviceType>/g, '<u:serviceType>')
      .replace(/<\/serviceType>/g, '</u:serviceType>')
      .replace(/<controlURL>/g, '<u:controlURL>')
      .replace(/<\/controlURL>/g, '</u:controlURL>');
    expect(findIgdControlTarget(prefixed, 'http://192.168.1.1/d.xml')?.controlUrl)
      .toBe('http://192.168.1.1/ctl/IPConn');
  });

  it('returns null rather than guessing when there is no WAN service', () => {
    expect(findIgdControlTarget('<root><device/></root>', 'http://192.168.1.1/d.xml'))
      .toBeNull();
  });
});

describe('D-273 — SOAP envelopes', () => {
  it('⛔ keeps ARGUMENT ORDER — IGD is positional in practice', () => {
    const req = buildSoapRequest({
      serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
      action: 'AddPortMapping',
      params: [
        ['NewRemoteHost', ''],
        ['NewExternalPort', 443],
        ['NewProtocol', 'TCP'],
        ['NewInternalPort', 443],
        ['NewInternalClient', '192.168.1.42'],
        ['NewEnabled', 1],
        ['NewPortMappingDescription', 'Recued'],
        ['NewLeaseDuration', 600],
      ],
    });
    expect(req.body.indexOf('NewExternalPort'))
      .toBeLessThan(req.body.indexOf('NewInternalPort'));
    expect(req.body).toContain(
      '<NewExternalPort>443</NewExternalPort><NewProtocol>TCP</NewProtocol>',
    );
    expect(req.soapAction)
      .toBe('"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"');
  });

  it('⚠ escapes values — a description with an ampersand must not break the envelope', () => {
    const req = buildSoapRequest({
      serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
      action: 'AddPortMapping',
      params: [['NewPortMappingDescription', 'Recued & co <x>']],
    });
    expect(req.body).toContain('Recued &amp; co &lt;x&gt;');
  });
});

describe('D-273 — SOAP faults', () => {
  const fault = (code: number) => `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>
<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
<errorCode>${String(code)}</errorCode><errorDescription>x</errorDescription>
</UPnPError></detail></s:Fault></s:Body></s:Envelope>`;

  it('⛔⛔ 714 is NO_SUCH_ENTRY — the answer enumeration exists to get', () => {
    // `GetSpecificPortMappingEntry` returns it to mean "nothing is mapped on
    // that port". Treating it as a failure makes the only thing IGD adds over
    // NAT-PMP unusable — and D-273 needs exactly this to tell a mapping the
    // owner made by hand from one we made.
    try {
      parseSoapResponse(fault(714));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IgdSoapError);
      expect((err as IgdSoapError).name_).toBe('no_such_entry');
      expect((err as IgdSoapError).code).toBe(714);
    }
  });

  it('⛔⛔ 725 is ONLY_PERMANENT_LEASES — it breaks the security model, so it is NAMED', () => {
    // D-273 leans on the lease as the ONLY bound on the hole, because nothing
    // releases on shutdown. A router that accepts permanent mappings only makes
    // "it expires on its own" false, and the owner has to be told rather than
    // handed a mapping that never goes away.
    try {
      parseSoapResponse(fault(725));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as IgdSoapError).name_).toBe('only_permanent_leases_supported');
    }
  });

  it.each([[718, 'conflict_in_mapping_entry'], [606, 'action_not_authorized']])(
    'names %i', (code, expected) => {
      try {
        parseSoapResponse(fault(code));
        expect.unreachable('should have thrown');
      } catch (err) { expect((err as IgdSoapError).name_).toBe(expected); }
    },
  );

  it('an unrecognised code keeps its number rather than being dropped', () => {
    try {
      parseSoapResponse(fault(999));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as IgdSoapError).name_).toBe('unknown');
      expect((err as IgdSoapError).code).toBe(999);
    }
  });

  it('⚠ a fault is detected from the BODY, whatever the HTTP status was', () => {
    // Routers return 500 for faults and some return 200, so a caller checking
    // `res.ok` first would read half the fleet's refusals as successes. Nothing
    // here looks at a status.
    expect(() => parseSoapResponse(fault(718))).toThrow(IgdSoapError);
  });

  it('a successful response comes back intact for the caller to read', () => {
    const ok = '<s:Envelope><s:Body><u:GetExternalIPAddressResponse>'
      + '<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>'
      + '</u:GetExternalIPAddressResponse></s:Body></s:Envelope>';
    expect(readTag(parseSoapResponse(ok), 'NewExternalIPAddress')).toBe('203.0.113.7');
  });
});

// ──────────────────────────────────────────────────────────────────
// Audit P2-11 — the absence of a fault is not a success.
// ──────────────────────────────────────────────────────────────────
describe('D-273 audit P2-11 — a reply must look like a reply to OUR action', () => {
  const ENVELOPE = (inner: string) =>
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">`
    + `<s:Body>${inner}</s:Body></s:Envelope>`;

  it('⛔⛔ an HTML ERROR PAGE is not a successful mapping', () => {
    // The transport discards the HTTP status (correctly — routers return faults
    // with 200 and successes with 500), and the parser returned on the mere
    // absence of a UPnPError. So a proxy's 503 page became a `mapped` record
    // with a lease that never existed, and the router forwarded nothing while
    // every surface said the port was open.
    for (const body of [
      '<html><body><h1>503 Service unavailable</h1></body></html>',
      '<html>404 Not Found</html>',
      '',
      'not xml at all',
    ]) {
      expect(() => parseSoapResponse(body, 'AddPortMapping'), body).toThrow(/not a SOAP envelope/);
    }
  });

  it('⛔ a generic SOAP Fault with no UPnPError body is still a refusal', () => {
    expect(() => parseSoapResponse(
      ENVELOPE('<s:Fault><faultstring>go away</faultstring></s:Fault>'),
      'AddPortMapping',
    )).toThrow(/SOAP fault/);
  });

  it('⛔ a well-formed envelope answering a DIFFERENT action is not evidence about ours', () => {
    expect(() => parseSoapResponse(
      ENVELOPE('<u:GetExternalIPAddressResponse/>'),
      'AddPortMapping',
    )).toThrow(/not a AddPortMappingResponse/);
  });

  it('accepts the real thing, self-closed or paired', () => {
    // ⚠ Gateways send both spellings. A check that understood one would refuse
    // working routers — this finding inverted.
    expect(parseSoapResponse(ENVELOPE('<u:AddPortMappingResponse/>'), 'AddPortMapping'))
      .toContain('AddPortMappingResponse');
    expect(parseSoapResponse(
      ENVELOPE('<u:AddPortMappingResponse xmlns:u="urn:x"></u:AddPortMappingResponse>'),
      'AddPortMapping',
    )).toContain('AddPortMappingResponse');
  });

  it('⚠ a UPnPError still wins, at any HTTP status and inside any envelope', () => {
    expect(() => parseSoapResponse(
      ENVELOPE('<s:Fault><detail><UPnPError><errorCode>725</errorCode></UPnPError></detail></s:Fault>'),
      'AddPortMapping',
    )).toThrow(/only_permanent_leases_supported/);
  });
});
