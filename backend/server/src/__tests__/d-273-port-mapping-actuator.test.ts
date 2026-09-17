/** D-273 P3 slice 1 — choosing a protocol. */

import { describe, expect, it, vi } from 'vitest';
import {
  createIgdDescriptionFetch,
  IGD_DESCRIPTION_MAX_BYTES,
  resolvePortMappingActuator,
} from '../network/port-mapping-actuator.js';
import type { SsdpTransport } from '../network/igd-discovery.js';

const DESCRIPTION = `<root><device><serviceList><service>
<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
<controlURL>/ctl/IPConn</controlURL></service></serviceList></device></root>`;

const ssdpReplying = (): SsdpTransport => ({
  async search() {
    return [[
      'HTTP/1.1 200 OK',
      'LOCATION: http://192.168.1.1:5000/rootDesc.xml',
      'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
      'USN: uuid:abc', '', '',
    ].join('\r\n')];
  },
});
const ssdpSilent = (): SsdpTransport => ({ async search() { return []; } });

const base = {
  gateway: '192.168.1.1',
  lanAddress: '192.168.1.42',
  httpPost: async () => '<ok/>',
  fetchDescription: async () => DESCRIPTION,
  natPmpSend: async () => Uint8Array.from([0, 128, 0, 0, 0, 0, 0, 0, 203, 0, 113, 7]),
};

describe('D-273 — which protocol', () => {
  it('⛔⛔ PREFERS IGD when it is there, because only IGD can ENUMERATE', async () => {
    // Without enumeration a client must delete a mapping it merely BELIEVES is
    // its own; if the router rebooted and another host took that port, the
    // delete takes theirs. Choosing the smaller protocol at runtime would trade
    // that safety for a round trip.
    const resolved = await resolvePortMappingActuator({ ...base, ssdp: ssdpReplying() });
    expect(resolved?.protocol).toBe('igd');
    expect(resolved?.getMapping).not.toBeNull();
  });

  it('falls back to NAT-PMP when no IGD answers', async () => {
    const resolved = await resolvePortMappingActuator({ ...base, ssdp: ssdpSilent() });
    expect(resolved?.protocol).toBe('nat-pmp');
  });

  it('⛔⛔ NAT-PMP reports `getMapping: null` — NOT an empty table', async () => {
    // "This protocol cannot be asked" and "nothing is mapped there" are
    // different facts. Confusing them would tell the boot matrix the port is
    // free on every router that speaks only NAT-PMP, and it would take the
    // `map` branch every single time — including over the owner's own forward.
    const resolved = await resolvePortMappingActuator({ ...base, ssdp: ssdpSilent() });
    expect(resolved?.getMapping).toBeNull();
  });

  it('⚠ a router that answers SSDP but whose description does not parse falls back', async () => {
    const resolved = await resolvePortMappingActuator({
      ...base, ssdp: ssdpReplying(), fetchDescription: async () => '<root/>',
    });
    expect(resolved?.protocol).toBe('nat-pmp');
  });

  it('⚠ a description fetch that THROWS falls back rather than taking the boot', async () => {
    // A port-mapping feature that threw on a quiet or hostile network would stop
    // the server starting.
    const resolved = await resolvePortMappingActuator({
      ...base,
      ssdp: ssdpReplying(),
      fetchDescription: async () => { throw new Error('connection refused'); },
    });
    expect(resolved?.protocol).toBe('nat-pmp');
  });

  it('⛔ no IGD and no gateway ⇒ null, not a throw', async () => {
    expect(await resolvePortMappingActuator({
      ...base, gateway: undefined, ssdp: ssdpSilent(),
    })).toBeNull();
  });

  it('⚠ SSDP is told to leave by THIS machine’s interface', async () => {
    // Multicast leaves by one interface; on a multi-homed host the wrong one is
    // indistinguishable from a router with no UPnP.
    // ⚠ PARAMETERS DECLARED. An argless `vi.fn` infers a 0-tuple for
    // `mock.calls`, so `calls[0][0]` is TS2493 — green under vitest and red
    // under `typecheck:tests`, which is exactly how it was caught here.
    const search = vi.fn(
      async (_args: { message: string; windowMs: number; bindAddress?: string }) =>
        [] as ReadonlyArray<string>,
    );
    await resolvePortMappingActuator({ ...base, ssdp: { search } });
    expect(search.mock.calls[0]?.[0]).toMatchObject({ bindAddress: '192.168.1.42' });
  });

  it('⚠ the IGD mapping is created for THIS machine as internal client', async () => {
    const posts: string[] = [];
    const resolved = await resolvePortMappingActuator({
      ...base, ssdp: ssdpReplying(),
      // ⚠ A real SOAP envelope — see audit P2-11; `'<ok/>'` is no longer a
      // success and should never have been.
      httpPost: async ({ body }) => { posts.push(body); return '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:AddPortMappingResponse/></s:Body></s:Envelope>'; },
    });
    await resolved?.actuator.map({
      protocol: 'tcp', internalPort: 443, externalPort: 443, lifetimeSeconds: 600,
    });
    expect(posts[0]).toContain('<NewInternalClient>192.168.1.42</NewInternalClient>');
  });
});

// ──────────────────────────────────────────────────────────────────
// Audit P2-13 — a cap applied after the download is not a cap.
// ──────────────────────────────────────────────────────────────────
describe('D-273 audit P2-13 — the size limit bounds the read, not just the result', () => {
  /** A body delivered in chunks, counting how many were actually pulled. */
  const streamed = (totalBytes: number, chunk = 64 * 1024) => {
    let sent = 0;
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (sent >= totalBytes) { controller.close(); return; }
        const size = Math.min(chunk, totalBytes - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size));
      },
      cancel() { cancelled = true; },
    });
    return { body, stats: () => ({ sent, pulls, cancelled }) };
  };

  it('⛔⛔ REFUSES AN OVERSIZE BODY WITHOUT DOWNLOADING ALL OF IT', async () => {
    // `await res.text()` completed the download and only then measured it, so
    // the advertised 256 KiB cap bounded nothing — a hostile LAN responder could
    // make detection allocate a body of any size, and detection runs with
    // mapping switched OFF.
    const { body, stats } = streamed(IGD_DESCRIPTION_MAX_BYTES * 8);
    const fetchDescription = createIgdDescriptionFetch(async () => new Response(body));
    await expect(fetchDescription('http://192.168.1.1/d.xml'))
      .rejects.toThrow(/implausibly large/);
    const s = stats();
    expect(s.sent).toBeLessThan(IGD_DESCRIPTION_MAX_BYTES * 2);
    expect(s.cancelled).toBe(true);
  });

  it('⚠ a body UNDER the cap still arrives whole', async () => {
    const payload = '<root>' + 'x'.repeat(1000) + '</root>';
    const fetchDescription = createIgdDescriptionFetch(async () => new Response(payload));
    expect(await fetchDescription('http://192.168.1.1/d.xml')).toBe(payload);
  });

  it('⚠ measures BYTES, not UTF-16 code units', async () => {
    // `text.length` counted code units, so a multi-byte body measured smaller
    // than it is — the cap read as generous by up to 3× exactly where the
    // content is attacker-chosen. Each of these is 3 bytes and one unit.
    const threeByteChars = '中'.repeat(IGD_DESCRIPTION_MAX_BYTES);
    const fetchDescription = createIgdDescriptionFetch(async () => new Response(threeByteChars));
    await expect(fetchDescription('http://192.168.1.1/d.xml'))
      .rejects.toThrow(/implausibly large/);
  });
});
