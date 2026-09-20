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

/** D-273 — the epoch is OMITTED when the gateway did not send one.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18). `...(epochSeconds !== undefined ? {...} :
 *  {})` could be replaced with a bare `epochSeconds,` and every test stayed
 *  green, for two compounding reasons:
 *
 *    1. `mkClient` above types `externalAddress` as returning `epochSeconds:
 *       number` — REQUIRED — while the production `PortMappingSupportProbe`
 *       declares it optional. No fixture could omit it, so the absent branch
 *       had no case at all.
 *    2. `toMatchObject` and `toEqual` treat `{ epochSeconds: undefined }` and
 *       `{}` as the same object, so even a fixture that omitted it would not
 *       have seen the difference.
 *
 *  ⛔ AND THE ABSENT CASE IS THE COMMON ONE. IGD is the PREFERRED protocol at
 *  runtime and its `externalAddress()` returns `{ externalIp }` alone — RFC
 *  6886's epoch is a NAT-PMP concept. So the untested branch is the one most
 *  installs take.
 *
 *  ⚠ This file's own idiom is "omitted, never defaulted", which is the same
 *  rule `network.local_urls` states one layer up: a consumer must be able to
 *  tell "the gateway did not say" from "the gateway said 0". A key present
 *  with `undefined` answers neither. */
describe('D-273 — an IGD-shaped probe carries no epoch', () => {
  const igdShapedProbe = (externalIp: string) => ({
    // Exactly what `createIgdClient().externalAddress()` resolves to.
    externalAddress: async () => ({ externalIp }),
  });

  it('⛔ the key is ABSENT, not present-and-undefined', async () => {
    const support = await detectPortMappingSupport(igdShapedProbe('203.0.113.7'));
    expect(support.kind).toBe('enabled');
    expect(
      'epochSeconds' in support,
      'the epoch key was emitted with no value — "did not say" is not "said nothing"',
    ).toBe(false);
    // ⚠ STRICT, because the loose matchers cannot tell those two apart.
    expect(support).toStrictEqual({
      kind: 'enabled',
      externalIp: '203.0.113.7',
      cgnat: false,
    });
  });

  it('⚠ and a NAT-PMP-shaped probe still carries the epoch it was given', async () => {
    // The complement: omitting is right only when there is nothing to send.
    const support = await detectPortMappingSupport({
      externalAddress: async () => ({ externalIp: '203.0.113.7', epochSeconds: 0 }),
    });
    // ⛔ ZERO, ON PURPOSE. A falsy-but-present epoch is exactly what a
    // `?? undefined` or a truthiness test would drop, and RFC 6886 § 3.2 makes
    // a reset gateway report 0 — the value a caller watching for the epoch
    // going backwards most needs to see.
    expect(support.epochSeconds).toBe(0);
    expect('epochSeconds' in support).toBe(true);
  });
});

