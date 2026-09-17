import { describe, expect, it } from 'vitest';
import { SERVER_RPC_METHOD_SET } from '@recued/contracts';

import {
  buildLocalServerUrls,
  handleNetworkLocalUrls,
  handleNetworkPortMapping,
  makeNetworkHandlers,
  type NetworkRpcDeps,
} from '../network-handler.js';

/** Minimal `os.networkInterfaces()` fake — `collectLanInterfaces` reads only
 *  `address` / `family` / `internal`, so the other NetworkInterfaceInfo fields
 *  are elided + the whole thing is cast to the override type. */
const fakeInterfaces = (
  entries: Array<{ address: string; family: 'IPv4' | 'IPv6'; internal: boolean }>,
): NetworkRpcDeps['networkInterfaces'] =>
  (() => ({ test0: entries })) as unknown as NetworkRpcDeps['networkInterfaces'];

describe('buildLocalServerUrls', () => {
  it('emits loopback first, then each non-internal LAN address with the port', () => {
    const urls = buildLocalServerUrls(
      8443,
      fakeInterfaces([
        { address: '192.168.1.42', family: 'IPv4', internal: false },
        { address: '10.0.0.5', family: 'IPv4', internal: false },
      ]),
    );
    expect(urls).toEqual([
      { url: 'http://localhost:8443', kind: 'loopback' },
      { url: 'http://192.168.1.42:8443', kind: 'lan' },
      { url: 'http://10.0.0.5:8443', kind: 'lan' },
    ]);
  });

  it('excludes internal + link-local IPv6 and brackets a global IPv6', () => {
    const urls = buildLocalServerUrls(
      7717,
      fakeInterfaces([
        { address: '127.0.0.1', family: 'IPv4', internal: true }, // internal → excluded
        { address: 'fe80::1', family: 'IPv6', internal: false }, // link-local → excluded
        { address: '2001:db8::1', family: 'IPv6', internal: false }, // global → bracketed
        { address: '192.168.0.2', family: 'IPv4', internal: false },
      ]),
    );
    expect(urls).toEqual([
      { url: 'http://localhost:7717', kind: 'loopback' },
      { url: 'http://[2001:db8::1]:7717', kind: 'lan' },
      { url: 'http://192.168.0.2:7717', kind: 'lan' },
    ]);
  });

  it('returns only the loopback row when there are no non-internal interfaces', () => {
    const urls = buildLocalServerUrls(
      3000,
      fakeInterfaces([{ address: '127.0.0.1', family: 'IPv4', internal: true }]),
    );
    expect(urls).toEqual([{ url: 'http://localhost:3000', kind: 'loopback' }]);
  });
});

describe('handleNetworkLocalUrls', () => {
  const deps: NetworkRpcDeps = {
    getPort: () => 8443,
    networkInterfaces: fakeInterfaces([
      { address: '192.168.1.42', family: 'IPv4', internal: false },
    ]),
  };

  it('rejects an unregistered (unpaired) caller — local-UI read, paired clients only', async () => {
    await expect(
      handleNetworkLocalUrls(deps, undefined, { instance_id: null }),
    ).rejects.toThrow(/requires a paired client/);
    await expect(
      handleNetworkLocalUrls(deps, undefined, undefined),
    ).rejects.toThrow(/requires a paired client/);
  });

  it('returns the reachable URLs for a paired caller', async () => {
    const res = await handleNetworkLocalUrls(deps, undefined, { instance_id: 'wc_1' });
    expect(res.urls).toEqual([
      { url: 'http://localhost:8443', kind: 'loopback' },
      { url: 'http://192.168.1.42:8443', kind: 'lan' },
    ]);
  });

  it('carries the LAN port as a number, not only inside a URL', async () => {
    // The caller that needs the number should not have to parse a URL for it,
    // and `getPort` is read post-bind — so a configured 0 reports what the OS
    // actually assigned.
    const res = await handleNetworkLocalUrls(deps, undefined, { instance_id: 'wc_1' });
    expect(res.lan_port).toBe(8443);
  });

  it('carries the public port when the embedding can say', async () => {
    const res = await handleNetworkLocalUrls(
      { ...deps, getPublicPort: () => 8446 }, undefined, { instance_id: 'wc_1' },
    );
    expect(res.public_port).toBe(8446);
  });

  it('⛔⛔ D-272 — reports the LAN listener as EXPOSED when the bind reaches a public address', async () => {
    // The cloud-VM shape: one private NIC, one public. `resolveLanAddress`
    // returns `0.0.0.0` for exactly that host, and there is no source-address
    // filter in the path router — so a PLAINTEXT listener carrying `/ws` and
    // `/mcp` is on the public address.
    const res = await handleNetworkLocalUrls(
      {
        ...deps,
        getLanBindAddress: () => '0.0.0.0',
        networkInterfaces: fakeInterfaces([
          { address: '172.31.4.10', family: 'IPv4', internal: false },
          { address: '203.0.113.7', family: 'IPv4', internal: false },
        ]),
      },
      undefined,
      { instance_id: 'wc_1' },
    );
    expect(res.lan_exposure).toEqual({
      publicly_routable: true,
      wildcard: true,
      public_addresses: ['203.0.113.7'],
    });
  });

  it('⛔ and NOT exposed for the ordinary home shape, which is also a wildcard bind', async () => {
    // 🔑 The wildcard alone is the DEFAULT, not the finding. Warning on it
    // would fire for nearly every install and teach the reader to ignore it.
    const res = await handleNetworkLocalUrls(
      { ...deps, getLanBindAddress: () => '0.0.0.0' },
      undefined,
      { instance_id: 'wc_1' },
    );
    // ⚠ `wildcard: true` AND `publicly_routable: false` together — the pair a
    // client must not collapse. The bind IS every interface; none of them is
    // routable from outside.
    expect(res.lan_exposure).toEqual({
      publicly_routable: false,
      wildcard: true,
      public_addresses: [],
    });
  });

  it('⛔⛔ D-272 — OMITS `lan_exposure` when nothing could say, never `false`', async () => {
    // Same rule as the public port beside it, and it matters more here: a
    // `publicly_routable: false` we invented is this server telling its owner
    // it is not exposed on the strength of having failed to look.
    const res = await handleNetworkLocalUrls(deps, undefined, { instance_id: 'wc_1' });
    expect(res.lan_exposure).toBeUndefined();
    expect('lan_exposure' in res).toBe(false);
  });

  it('⛔ OMITS the public port rather than inventing 443', async () => {
    // A client receiving nothing can tell "this server did not say" from "this
    // server says 443". One receiving a 443 we made up cannot — and it builds
    // the address it hands the user out of that number.
    const res = await handleNetworkLocalUrls(deps, undefined, { instance_id: 'wc_1' });
    expect('public_port' in res).toBe(false);
  });
});

describe('makeNetworkHandlers', () => {
  it('returns undefined when deps are absent (db-less / unconfigured boot)', () => {
    expect(makeNetworkHandlers(undefined)).toBeUndefined();
  });

  it('exposes the network.local_urls method when deps are present', () => {
    const slice = makeNetworkHandlers({ getPort: () => 8443 });
    expect(slice?.methods).toEqual(['network.local_urls']);
  });

  it('network.local_urls is in SERVER_RPC_METHOD_SET (else ws-server wire-completeness throws at boot)', () => {
    // Guards the runtime dispatch-list vs type-registry drift: a wired method
    // absent from SERVER_RPC_METHODS fails the boot-time wire check. Catch it
    // here instead of at server startup.
    expect(SERVER_RPC_METHOD_SET.has('network.local_urls')).toBe(true);
  });
});

describe('D-273 — network.port_mapping', () => {
  const caller = { instance_id: 'wc_1' };
  const deps = (over: Partial<Parameters<typeof handleNetworkPortMapping>[0]> = {}) => ({
    getStatus: () => null,
    isEnabled: () => false,
    ...over,
  });

  it('rejects an unregistered caller — this reports whether a hole is open', async () => {
    await expect(
      handleNetworkPortMapping(deps(), undefined, { instance_id: null }),
    ).rejects.toThrow(/paired client/);
  });

  it('⛔ before the first reconcile it reports the toggle and NOTHING ELSE', async () => {
    // Every other field absent means "we have not looked", which is true.
    const res = await handleNetworkPortMapping(deps(), undefined, caller);
    expect(res).toEqual({ enabled: false });
  });

  it('⛔⛔ OMITS `support` for `unknown` — never reports `unsupported`', async () => {
    // "We could not ask" is a fact about this host, not about a router. The
    // router step says something different for each, so collapsing them makes
    // one of those sentences a lie.
    const res = await handleNetworkPortMapping(deps({
      isEnabled: () => true,
      getStatus: () => ({
        last: null, unavailable: 'no_gateway', checkedAt: 5,
        support: { kind: 'unknown', detail: 'no default-route gateway to ask' },
      }),
    }), undefined, caller);
    expect(res.support).toBeUndefined();
    expect(res.unavailable).toBe('no_gateway');
    expect(res.checked_at).toBe(5);
  });

  it('⚠ OMITS `cgnat` when the gateway never told us its external address', async () => {
    // `cgnat: false` from a router we never reached would read as an all-clear
    // nobody earned.
    const res = await handleNetworkPortMapping(deps({
      getStatus: () => ({
        last: null, unavailable: null, checkedAt: 1,
        support: { kind: 'disabled', detail: 'switched off' },
      }),
    }), undefined, caller);
    expect(res.support).toBe('disabled');
    expect('cgnat' in res).toBe(false);
  });

  it('reports a live mapping, its protocol and the port ACTUALLY assigned', async () => {
    const res = await handleNetworkPortMapping(deps({
      isEnabled: () => true,
      getProtocol: () => 'igd',
      getStatus: () => ({
        last: {
          outcome: 'mapped', reason: 'no_record',
          record: {
            gateway: '192.168.1.1', protocol: 'tcp', internalPort: 443,
            internalIp: '192.168.1.42', externalPort: 9443,
            createdAt: 1, lifetimeSeconds: 600,
          },
        },
        unavailable: null, checkedAt: 7,
        support: { kind: 'enabled', externalIp: '203.0.113.7', cgnat: false },
      }),
    }), undefined, caller);
    expect(res).toMatchObject({
      enabled: true, support: 'enabled', cgnat: false, protocol: 'igd',
      outcome: 'mapped', external_port: 9443, checked_at: 7,
    });
  });

  it('⛔ CGNAT is carried — the answer that makes the whole feature pointless', async () => {
    const res = await handleNetworkPortMapping(deps({
      getStatus: () => ({
        last: null, unavailable: null, checkedAt: 1,
        support: {
          kind: 'enabled', externalIp: '100.64.1.5', cgnat: true,
          detail: 'gateway is behind carrier-grade NAT; a mapping will not be reachable',
        },
      }),
    }), undefined, caller);
    expect(res.cgnat).toBe(true);
    expect(res.detail).toMatch(/carrier-grade NAT/);
  });

  it('⚠ a failure carries its OWN detail, not the detector’s', async () => {
    const res = await handleNetworkPortMapping(deps({
      getStatus: () => ({
        last: { outcome: 'unavailable', reason: 'no_record', record: null, error: 'refused' },
        unavailable: null, checkedAt: 2,
        support: { kind: 'enabled', detail: 'detector said something else' },
      }),
    }), undefined, caller);
    expect(res.detail).toBe('refused');
  });
});
