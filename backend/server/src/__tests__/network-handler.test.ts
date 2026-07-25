import { describe, expect, it } from 'vitest';
import { SERVER_RPC_METHOD_SET } from '@recued/contracts';

import {
  buildLocalServerUrls,
  handleNetworkLocalUrls,
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
