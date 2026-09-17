/** D-273 P0 — detection: does this router do port mapping, and would it help? */

import { describe, expect, it } from 'vitest';
import { detectPortMappingSupport } from '../network/port-mapping-support.js';
import { NatPmpError, type NatPmpClient } from '../network/nat-pmp.js';
import { IgdSoapError } from '../network/igd-soap.js';

const mkClient = (
  externalAddress: () => Promise<{ externalIp: string; epochSeconds: number }>,
): NatPmpClient => ({
  externalAddress,
  map: async () => { throw new Error('not used by detection'); },
  unmap: async () => { throw new Error('not used by detection'); },
});

describe('D-273 — detecting port-mapping support', () => {
  it('a gateway that answers is `enabled`, and carries its external address', async () => {
    const support = await detectPortMappingSupport(mkClient(
      async () => ({ externalIp: '203.0.113.7', epochSeconds: 3600 }),
    ));
    expect(support).toMatchObject({
      kind: 'enabled', externalIp: '203.0.113.7', epochSeconds: 3600, cgnat: false,
    });
  });

  it('⛔⛔ CGNAT is `enabled` AND flagged — a mapping will succeed and change nothing', async () => {
    // The ISP is NATing upstream of this router, so the port it forwards is not
    // reachable. Without this the owner forwards a port, tests it, and finds no
    // fault at either end.
    const support = await detectPortMappingSupport(mkClient(
      async () => ({ externalIp: '100.64.1.5', epochSeconds: 10 }),
    ));
    expect(support.kind).toBe('enabled');
    expect(support.cgnat).toBe(true);
    expect(support.detail).toMatch(/carrier-grade NAT/);
  });

  it('⛔ REFUSED is `disabled`, not `unsupported` — this owner has a switch to flip', async () => {
    // RFC 6886 § 3.5 spells the case out: "box supports mapping, but user has
    // turned feature off". Collapsing it into `unsupported` tells someone with a
    // working router that their router cannot do it.
    const support = await detectPortMappingSupport(mkClient(async () => {
      throw new NatPmpError('not_authorized', 2, 'nat-pmp: not_authorized');
    }));
    expect(support.kind).toBe('disabled');
  });

  it('⛔⛔ an IGD refusal is `disabled` too — BOTH protocols have a "refused"', async () => {
    // IGD is the PREFERRED protocol at runtime, so a detector that understood
    // only NAT-PMP's refusal would report every IGD router with UPnP switched
    // off as `unsupported` — telling an owner with a capable router that it
    // cannot do this, and hiding the switch they could flip.
    const support = await detectPortMappingSupport({
      externalAddress: async () => {
        throw new IgdSoapError(606, 'action_not_authorized', 'igd: action_not_authorized');
      },
    });
    expect(support.kind).toBe('disabled');
  });

  it('⚠ any OTHER IGD fault is `unsupported`, with the reason kept', async () => {
    const support = await detectPortMappingSupport({
      externalAddress: async () => {
        throw new IgdSoapError(501, 'action_failed', 'igd: action_failed');
      },
    });
    expect(support.kind).toBe('unsupported');
    expect(support.detail).toMatch(/action_failed/);
  });

  it('a protocol error is `unsupported`, and the detail says WHICH', async () => {
    // `unsupported_version` is a PCP-only gateway, and that answer becomes wrong
    // the day P2 adds PCP — so the reason is kept rather than flattened.
    const support = await detectPortMappingSupport(mkClient(async () => {
      throw new NatPmpError('unsupported_version', 1, 'nat-pmp: unsupported_version');
    }));
    expect(support.kind).toBe('unsupported');
    expect(support.detail).toMatch(/unsupported_version/);
  });

  it('⚠ SILENCE is `unsupported` — we asked, and the router declined to answer', async () => {
    const support = await detectPortMappingSupport(mkClient(async () => {
      throw new Error('nat-pmp: timeout');
    }));
    expect(support.kind).toBe('unsupported');
  });

  it('⛔⛔ NO GATEWAY is `unknown` — a fact about THIS HOST, not about a router', async () => {
    // `readDefaultRouteGateway()` returns undefined on win32. Reporting that as
    // `unsupported` states a fact about a router nobody asked.
    expect(await detectPortMappingSupport(null)).toMatchObject({ kind: 'unknown' });
  });
});
