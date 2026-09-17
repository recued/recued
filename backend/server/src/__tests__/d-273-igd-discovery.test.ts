/** D-273 P2 — SSDP discovery. */

import { describe, expect, it } from 'vitest';
import {
  buildSsdpSearch,
  discoverIgd,
  isPlausibleIgdLocation,
  parseSsdpReply,
  SSDP_MX_SECONDS,
  type SsdpTransport,
} from '../network/igd-discovery.js';

const reply = (over: Partial<Record<string, string>> = {}): string => {
  const h = {
    st: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    location: 'http://192.168.1.1:5000/rootDesc.xml',
    usn: 'uuid:abc::urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    ...over,
  };
  return [
    'HTTP/1.1 200 OK', 'CACHE-CONTROL: max-age=1800', 'EXT:',
    `LOCATION: ${h.location}`, `ST: ${h.st}`, `USN: ${h.usn}`, '', '',
  ].join('\r\n');
};

describe('D-273 — the M-SEARCH datagram', () => {
  it('⛔ uses CRLF and ends with a BLANK LINE', () => {
    // SSDP is HTTPU. Many routers drop an LF-only message without a word, which
    // reads exactly like a router that does not support UPnP.
    const msg = buildSsdpSearch({ searchTarget: 'x' });
    expect(msg).not.toMatch(/[^\r]\n/);
    expect(msg.endsWith('\r\n\r\n')).toBe(true);
  });

  it('⛔ QUOTES the MAN header', () => {
    // `MAN: ssdp:discover` unquoted is rejected by a large slice of devices —
    // another silent no-answer.
    expect(buildSsdpSearch({ searchTarget: 'x' })).toContain('MAN: "ssdp:discover"');
  });

  it('carries HOST, MX and ST', () => {
    const msg = buildSsdpSearch({ searchTarget: 'urn:test', mxSeconds: 3 });
    expect(msg).toContain('HOST: 239.255.255.250:1900');
    expect(msg).toContain('MX: 3');
    expect(msg).toContain('ST: urn:test');
    expect(msg.startsWith('M-SEARCH * HTTP/1.1\r\n')).toBe(true);
  });
});

describe('D-273 — parsing a reply', () => {
  it('⚠ header names are CASE-INSENSITIVE, and vendors use every casing', () => {
    const lower = reply().replace('LOCATION:', 'location:').replace('ST:', 'St:');
    expect(parseSsdpReply(lower)).toMatchObject({
      location: 'http://192.168.1.1:5000/rootDesc.xml',
    });
  });

  it('refuses anything that is not a 200, and anything missing LOCATION or ST', () => {
    expect(parseSsdpReply('HTTP/1.1 404 Not Found\r\n\r\n')).toBeNull();
    expect(parseSsdpReply('NOTIFY * HTTP/1.1\r\nLOCATION: http://192.168.1.1/\r\n\r\n'))
      .toBeNull();
    expect(parseSsdpReply(reply({ location: '' }))).toBeNull();
  });
});

describe('D-273 — bounding what we will fetch', () => {
  it('⛔⛔ REFUSES a public LOCATION — the reply is UNAUTHENTICATED', () => {
    // Any device on the network can answer an M-SEARCH, and whatever LOCATION it
    // names is a URL this server then requests. A LAN peer advertising a public
    // address is broken or hostile, and following it makes this server fetch an
    // attacker-chosen URL on their behalf.
    expect(isPlausibleIgdLocation('http://203.0.113.7/desc.xml')).toBe(false);
    expect(isPlausibleIgdLocation('http://evil.example.com/desc.xml')).toBe(false);
  });

  it('⛔ refuses LOOPBACK — that is something on THIS host claiming to be a router', () => {
    expect(isPlausibleIgdLocation('http://127.0.0.1:5000/desc.xml')).toBe(false);
  });

  it('accepts RFC1918 and link-local, which is where routers actually live', () => {
    for (const ok of [
      'http://192.168.1.1:5000/d.xml',
      'http://10.0.0.1/d.xml',
      'http://172.16.3.1/d.xml',
      'http://169.254.1.1/d.xml',
      'http://[fe80::1]:5000/d.xml',
    ]) expect(isPlausibleIgdLocation(ok)).toBe(true);
  });

  it('refuses a non-http scheme and unparseable junk', () => {
    expect(isPlausibleIgdLocation('file:///etc/passwd')).toBe(false);
    expect(isPlausibleIgdLocation('not a url')).toBe(false);
  });

  it('⛔⛔ REFUSES A DNS NAME THAT MERELY *LOOKS* PRIVATE — a name is not an address', () => {
    // 🔑 THE BUG THIS REPLACES, found by audit 2026-09-16. The check was three
    // unanchored prefix regexes over the hostname STRING, so every one of these
    // passed: they are ordinary DNS names whose owner points them wherever they
    // like, including at this server's own LAN listener.
    //
    // ⚠ NOTE WHAT THE OLD TESTS PROBED: `evil.example.com`, which fails a prefix
    // match and so was rejected for the wrong reason. The suite tested where the
    // author was looking, not where the predicate was weak.
    for (const hostile of [
      'http://10.evil.com/desc.xml',
      'http://192.168.1.attacker.example/desc.xml',
      'http://172.16.x.attacker.net/desc.xml',
      'http://169.254.evil.test/desc.xml',
      'http://10.0.0.1.attacker.com/desc.xml',
    ]) expect(isPlausibleIgdLocation(hostile), hostile).toBe(false);
  });

  it('⚠ refuses IPv4-mapped IPv6 and other spellings of a public address', () => {
    // `::ffff:10.0.0.1` is a private v4 address wearing a v6 suit; the textual
    // v6 prefixes this accepts (fe80::/10, fc00::/7) exclude it by construction
    // rather than by a rule someone has to remember.
    expect(isPlausibleIgdLocation('http://[::ffff:10.0.0.1]/d.xml')).toBe(false);
    expect(isPlausibleIgdLocation('http://[::ffff:203.0.113.7]/d.xml')).toBe(false);
    expect(isPlausibleIgdLocation('http://[::1]/d.xml')).toBe(false);
    expect(isPlausibleIgdLocation('http://[2001:db8::1]/d.xml')).toBe(false);
  });

  it('accepts unique-local v6', () => {
    expect(isPlausibleIgdLocation('http://[fd00::1]/d.xml')).toBe(true);
    expect(isPlausibleIgdLocation('http://[fe80::1]:5000/d.xml')).toBe(true);
  });

  it('⚠ a ZONED link-local LOCATION is refused, and not by this predicate', () => {
    // `new URL('http://[fe80::1%25eth0]/')` THROWS — the WHATWG parser rejects a
    // zone id in a literal outright, so the refusal happens before any address
    // check runs. Asserted because the first draft of the fix claimed to handle
    // zones and could not have: nothing downstream of `new URL` ever sees one.
    // ⚠ If real gear turns out to advertise zoned LOCATIONs, the fix is in the
    // parse, not in the predicate.
    expect(isPlausibleIgdLocation('http://[fe80::1%25eth0]:5000/d.xml')).toBe(false);
  });
});

describe('D-273 — discovery', () => {
  const mkTransport = (
    byTarget: Record<string, string[]>,
  ): SsdpTransport & { calls: { message: string; windowMs: number; bindAddress?: string }[] } => {
    const calls: { message: string; windowMs: number; bindAddress?: string }[] = [];
    return {
      calls,
      async search(args) {
        calls.push(args);
        // ⚠ ANCHORED TO A LINE START. `/ST: /` also matches inside `HOST: `,
        // so the unanchored version captured `239.255.255.250:1900` and this
        // whole suite reported "no router answered". Production is unaffected —
        // `parseSsdpReply` splits into lines first — but the helper had to be
        // fixed before any of these tests meant anything.
        const st = /\r\nST: (.+)\r\n/.exec(args.message)?.[1] ?? '';
        return byTarget[st] ?? [];
      },
    };
  };

  const IGD1 = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1';
  const IGD2 = 'urn:schemas-upnp-org:device:InternetGatewayDevice:2';

  it('finds a router and returns its description location', async () => {
    const t = mkTransport({ [IGD1]: [reply()] });
    expect(await discoverIgd({ transport: t })).toMatchObject({
      location: 'http://192.168.1.1:5000/rootDesc.xml',
      searchTarget: IGD1,
    });
  });

  it('⚠ falls through to IGD:2 when :1 answers nothing', async () => {
    const t = mkTransport({ [IGD2]: [reply({ st: IGD2 })] });
    expect((await discoverIgd({ transport: t }))?.searchTarget).toBe(IGD2);
    expect(t.calls).toHaveLength(2);
  });

  it('⛔ the collection window is never SHORTER than MX', async () => {
    // Replies are spread randomly across the MX window to avoid a stampede, so a
    // shorter window silently misses the slow half of the fleet and reports "no
    // router found".
    const t = mkTransport({});
    await discoverIgd({ transport: t, windowMs: 10 });
    expect(t.calls[0]?.windowMs).toBeGreaterThanOrEqual(SSDP_MX_SECONDS * 1000);
  });

  it('⛔⛔ passes the BIND ADDRESS through — multicast leaves by ONE interface', async () => {
    // A host with a Docker bridge, a VPN tunnel and a real LAN will send it out
    // the wrong one, where no router is listening — indistinguishable from a
    // router that does not do UPnP.
    const t = mkTransport({ [IGD1]: [reply()] });
    await discoverIgd({ transport: t, bindAddress: '192.168.1.42' });
    expect(t.calls[0]?.bindAddress).toBe('192.168.1.42');
  });

  it('⛔ skips a reply whose ST is not the one we asked for', async () => {
    const t = mkTransport({ [IGD1]: [reply({ st: 'upnp:rootdevice' })] });
    expect(await discoverIgd({ transport: t })).toBeNull();
  });

  it('⛔ skips a reply pointing somewhere we will not fetch, and keeps looking', async () => {
    const t = mkTransport({
      [IGD1]: [
        reply({ location: 'http://203.0.113.7/d.xml', usn: 'uuid:evil' }),
        reply({ usn: 'uuid:real' }),
      ],
    });
    expect((await discoverIgd({ transport: t }))?.location)
      .toBe('http://192.168.1.1:5000/rootDesc.xml');
  });

  it('⚠ dedupes a device that answers twice — multi-homed routers routinely do', async () => {
    // Counting those as different devices would make "several routers replied"
    // the normal case.
    const t = mkTransport({ [IGD1]: [reply(), reply(), reply()] });
    const found = await discoverIgd({ transport: t });
    expect(found?.usn).toBe('uuid:abc::urn:schemas-upnp-org:device:InternetGatewayDevice:1');
  });

  it('returns null when nothing answers, rather than throwing', async () => {
    expect(await discoverIgd({ transport: mkTransport({}) })).toBeNull();
  });
});
