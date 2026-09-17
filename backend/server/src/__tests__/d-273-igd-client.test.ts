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
