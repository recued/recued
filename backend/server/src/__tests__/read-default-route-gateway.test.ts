/** Default-route gateway probe — the hint that resolves the multi-homed case.
 *
 *  Parsers are pure; the platform readers are injected, so these run the real
 *  fixture shapes (`/proc/net/route` rows, `route -n get default` output)
 *  without a routing table. The contract under test is as much about what the
 *  probe REFUSES to return — the boot path must never get a wrong gateway,
 *  because a wrong gateway silently binds the wrong interface.
 */

import { describe, expect, it } from 'vitest';
import {
  parseProcNetRouteGateway,
  parseRouteGetDefaultGateway,
  readDefaultRouteGateway,
} from '../network/read-default-route-gateway.js';

const PROC_HEADER =
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';

describe('parseProcNetRouteGateway', () => {
  it('decodes the LITTLE-ENDIAN hex gateway', () => {
    // 010011AC → AC.11.00.01 → 172.17.0.1. Read big-endian it would be
    // 1.0.17.172 — a plausible-looking address that matches no interface,
    // so this is the assertion that catches a reversed conversion.
    const out = parseProcNetRouteGateway(
      `${PROC_HEADER}\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0`,
    );
    expect(out).toBe('172.17.0.1');
  });

  it('reads the DEFAULT row only — a subnet route is not a gateway', () => {
    const out = parseProcNetRouteGateway(
      [
        PROC_HEADER,
        // On-link /24 for the LAN: destination non-zero, gateway zero.
        'eth0\t0001A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
        // The actual default route.
        'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      ].join('\n'),
    );
    expect(out).toBe('192.168.1.1');
  });

  it('⛔ a SUBNET route VIA A GATEWAY is still not the default route', () => {
    // ⚠ FOUND BY MUTATION. The case above has a non-default row whose gateway
    // is ALSO zero, so the gateway filter excluded it and the DESTINATION
    // filter never ran — deleting that filter reddened nothing. A real routing
    // table has subnet routes that do go via a router (a VPN's 10.0.0.0/8 via
    // 192.168.1.254), and taking one as "the default" points every port-mapping
    // request at the wrong device.
    const out = parseProcNetRouteGateway(
      [
        PROC_HEADER,
        // 10.0.0.0/8 via 192.168.1.254 — a real gateway, NOT the default route,
        // and with a LOWER metric so it wins on every tiebreak but the right one.
        'tun0\t0000000A\tFE01A8C0\t0003\t0\t0\t10\t000000FF\t0\t0\t0',
        // The actual default route, deliberately later and worse-metric.
        'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      ].join('\n'),
    );
    expect(out).toBe('192.168.1.1');
  });

  it('⛔ a zero GATEWAY on a default row is not an address', () => {
    // Its own case: the previous fixtures conflate this filter with the
    // destination one. `0.0.0.0` parses as a dotted quad, so without this the
    // on-link default would be handed to the router as a gateway.
    const out = parseProcNetRouteGateway(
      [
        PROC_HEADER,
        'eth0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0',
        'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      ].join('\n'),
    );
    expect(out).toBe('192.168.1.1');
  });

  it('⛔ malformed hex in the gateway column is skipped, not converted', () => {
    const out = parseProcNetRouteGateway(
      [
        PROC_HEADER,
        'eth0\t00000000\tZZZZZZZZ\t0003\t0\t0\t1\t00000000\t0\t0\t0',
        'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      ].join('\n'),
    );
    expect(out).toBe('192.168.1.1');
  });

  it('⚠ prefers the lowest metric even when it is the FIRST row', () => {
    // The existing metric case lists the winner LAST, so "lowest metric wins"
    // and "last row wins" agree and the comparison is never tested. This is the
    // same table with the order reversed.
    const out = parseProcNetRouteGateway(
      [
        PROC_HEADER,
        'eth0\t00000000\t010011AC\t0003\t0\t0\t100\t00000000\t0\t0\t0',  // 172.17.0.1
        'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0', // 192.168.1.1
      ].join('\n'),
    );
    expect(out).toBe('172.17.0.1');
  });

  it('prefers the LOWEST metric when several interfaces publish a default', () => {
    const out = parseProcNetRouteGateway(
      [
        PROC_HEADER,
        'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0', // 192.168.1.1
        'eth0\t00000000\t010011AC\t0003\t0\t0\t100\t00000000\t0\t0\t0', // 172.17.0.1
      ].join('\n'),
    );
    expect(out).toBe('172.17.0.1');
  });

  it('returns undefined with no default route, a header only, or garbage', () => {
    expect(parseProcNetRouteGateway(PROC_HEADER)).toBeUndefined();
    expect(parseProcNetRouteGateway('')).toBeUndefined();
    expect(
      parseProcNetRouteGateway(`${PROC_HEADER}\neth0\t0001A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0`),
    ).toBeUndefined();
    // Truncated / non-hex gateway must not produce a partial address.
    expect(
      parseProcNetRouteGateway(`${PROC_HEADER}\neth0\t00000000\tZZZZ\t0003\t0\t0\t0\t00000000\t0\t0\t0`),
    ).toBeUndefined();
  });
});

describe('parseRouteGetDefaultGateway', () => {
  it('⛔ the FIRST gateway line decides — a later address does not rescue it', () => {
    // ⚠ FOUND BY MUTATION: changing the `link#` branch from `return undefined`
    // to `continue` was invisible, because every fixture has one gateway line.
    // Real `route -n get default` prints one — but "the first line decides" is
    // a DELIBERATE choice (a point-to-point route genuinely has no gateway
    // address), and a parser that kept scanning would turn malformed output
    // into a confident wrong answer instead of an honest undefined.
    expect(parseRouteGetDefaultGateway(
      ['   route to: default', '   gateway: link#14', '   gateway: 192.168.1.1'].join('\n'),
    )).toBeUndefined();
  });

  it('⚠ `gateway:` must be the KEY, not a substring of some other line', () => {
    // The regex is anchored at line start for a reason; without that, any line
    // mentioning a gateway would be read as one.
    expect(parseRouteGetDefaultGateway(
      ['   route to: default', '   note: no gateway: 10.0.0.1 was found'].join('\n'),
    )).toBeUndefined();
  });

  it('reads the gateway line out of a BSD key/value block', () => {
    expect(
      parseRouteGetDefaultGateway(
        [
          '   route to: default',
          'destination: default',
          '       mask: default',
          '    gateway: 192.168.1.1',
          '  interface: en0',
        ].join('\n'),
      ),
    ).toBe('192.168.1.1');
  });

  it('returns undefined for a link# gateway (direct route, not an address)', () => {
    // A real macOS shape on a point-to-point link. It IS a gateway line, so
    // matching the label alone would hand the resolver "link#14" to prefix-
    // match against — nonsense that silently matches nothing.
    expect(
      parseRouteGetDefaultGateway('   route to: default\n    gateway: link#14\n  interface: utun3'),
    ).toBeUndefined();
  });

  it('returns undefined when the host has no default route', () => {
    expect(
      parseRouteGetDefaultGateway('route: writing to routing socket: not in table\n'),
    ).toBeUndefined();
    expect(parseRouteGetDefaultGateway('')).toBeUndefined();
  });
});

describe('readDefaultRouteGateway', () => {
  it('reads /proc/net/route on linux', () => {
    const out = readDefaultRouteGateway({
      platform: 'linux',
      readProcNetRoute: () =>
        `${PROC_HEADER}\neth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0`,
      runRouteGetDefault: () => {
        throw new Error('must not shell out on linux');
      },
    });
    expect(out).toBe('192.168.1.1');
  });

  it('runs `route get default` on darwin', () => {
    const out = readDefaultRouteGateway({
      platform: 'darwin',
      readProcNetRoute: () => {
        throw new Error('must not read procfs on darwin');
      },
      runRouteGetDefault: () => '    gateway: 10.0.0.1\n',
    });
    expect(out).toBe('10.0.0.1');
  });

  it('NEVER throws — a reader that blows up degrades to no hint', () => {
    // The boot path calls this before binding the listener. A container
    // without procfs, a missing `route` binary, and a subprocess timeout all
    // land here, and every one of them must be "resolve ambiguously" rather
    // than "the server does not start".
    expect(
      readDefaultRouteGateway({
        platform: 'linux',
        readProcNetRoute: () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      }),
    ).toBeUndefined();
    expect(
      readDefaultRouteGateway({
        platform: 'darwin',
        runRouteGetDefault: () => {
          throw new Error('ETIMEDOUT');
        },
      }),
    ).toBeUndefined();
  });

  it('returns undefined on a platform with neither source', () => {
    expect(readDefaultRouteGateway({ platform: 'win32' })).toBeUndefined();
  });

  it('runs against THIS host without throwing', () => {
    // The injected cases above all stub the platform seam; this one exercises
    // the real reader on whatever machine the suite runs on. Asserting the
    // VALUE would be host-dependent, so assert the contract that matters:
    // it answers, and it answers with an address or nothing.
    const out = readDefaultRouteGateway();
    if (out !== undefined) expect(out).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
  });
});
