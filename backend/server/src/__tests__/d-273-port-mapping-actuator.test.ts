/** D-273 P3 slice 1 — choosing a protocol. */

import { describe, expect, it, vi } from 'vitest';
import {
  createIgdDescriptionFetch,
  IGD_DESCRIPTION_MAX_BYTES,
  IGD_HTTP_TIMEOUT_MS,
  createIgdHttpPost,
  createSsdpTransport,
  type SsdpSocket,
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

  it('⛔⛔ REFUSES TO FOLLOW A REDIRECT — confinement survives the hop', async () => {
    // ⚠ FOUND BY MUTATION: flipping `redirect: 'error'` to `'follow'` reddened
    // nothing. The description URL is confined to a private host
    // (`isPlausibleIgdLocation`) and the control URL is confined to that same
    // host — but a 302 is a THIRD way out, and it is the only one the callers
    // cannot see: the fetch would land on a public host with every earlier
    // check already passed.
    //
    // ⛔ The device at the far end chose the Location header, and that device
    // was itself chosen by an unauthenticated multicast datagram.
    let passedInit: RequestInit | undefined;
    const fetchDescription = createIgdDescriptionFetch((async (_url: string, init?: RequestInit) => {
      passedInit = init;
      return new Response('<root/>');
    }) as unknown as typeof globalThis.fetch);
    await fetchDescription('http://192.168.1.1/d.xml');
    expect(
      passedInit?.redirect,
      'the description fetch would follow a redirect off the confined host',
    ).toBe('error');
  });

  it('⚠ a real redirect response therefore REJECTS rather than resolving', async () => {
    // The behavioural half: `redirect: 'error'` makes fetch throw, so this is
    // not merely a flag being set on an object nobody honours.
    const fetchDescription = createIgdDescriptionFetch((async () => {
      throw new TypeError('fetch failed: redirect mode is error');
    }) as unknown as typeof globalThis.fetch);
    await expect(fetchDescription('http://192.168.1.1/d.xml')).rejects.toThrow();
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

/** D-273 — the resolver's degradation ladder, and the port it deletes by.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18). Six branches of `resolvePortMappingActuator`
 *  had no case: a missing `fetchDescription` or `httpPost`, a null discovery, a
 *  null control target, and a blank gateway string. Each one falls through to
 *  the next option by design — "a port-mapping feature that threw on a quiet
 *  network would take the boot with it" — and each could be deleted green. */
describe('D-273 — the resolver degrades rather than throwing', () => {
  it('⛔ without a `fetchDescription` seam, IGD is not attempted at all', async () => {
    // The description is how a control URL is found; SSDP alone cannot build a
    // client. Attempting IGD here would call `undefined` and throw on a network
    // that simply has no description fetcher wired.
    const { fetchDescription: _omitted, ...noFetch } = base;
    const resolved = await resolvePortMappingActuator({
      ...noFetch, ssdp: ssdpReplying(),
    } as Parameters<typeof resolvePortMappingActuator>[0]);
    expect(resolved?.protocol).toBe('nat-pmp');
  });

  it('⛔ without an `httpPost` seam, IGD is not built', async () => {
    // Every IGD operation is a SOAP POST. An actuator with no transport would
    // resolve as `igd` and then fail on first use, which reads to the operator
    // as "UPnP is broken" rather than "UPnP was never wired".
    const { httpPost: _omitted, ...noPost } = base;
    const resolved = await resolvePortMappingActuator({
      ...noPost, ssdp: ssdpReplying(),
    } as Parameters<typeof resolvePortMappingActuator>[0]);
    expect(resolved?.protocol).toBe('nat-pmp');
  });

  it('⛔ a silent network falls straight through — discovery finding nothing is not an IGD', async () => {
    const resolved = await resolvePortMappingActuator({ ...base, ssdp: ssdpSilent() });
    expect(resolved?.protocol).toBe('nat-pmp');
  });

  it('⛔ a BLANK gateway string is not a gateway', async () => {
    // `''` is what an unreadable routing table produces. Building a NAT-PMP
    // client for it sends packets to nowhere and reports a mapping failure the
    // operator cannot act on, instead of the honest "no router found".
    for (const gateway of ['', '   ']) {
      const resolved = await resolvePortMappingActuator({
        ...base, gateway, ssdp: ssdpSilent(),
      });
      expect(resolved, `gateway ${JSON.stringify(gateway)} built an actuator`).toBeNull();
    }
  });

  it('⛔⛔ IGD unmap deletes by the CALLER’S EXTERNAL PORT, never the internal one', async () => {
    // ⛔ THIS IS A DOCUMENTED PAST BUG WITH NO TEST. The adapter passed
    // `externalPort: a.internalPort`, which is fine only while the two agree —
    // and wrong exactly when a router assigned a port we did not ask for, which
    // is when the record matters most. IGD's DeletePortMapping keys on (remote
    // host, EXTERNAL port, protocol), so the substitution deleted a DIFFERENT
    // entry, or nothing, and left ours open.
    const bodies: string[] = [];
    const resolved = await resolvePortMappingActuator({
      ...base,
      ssdp: ssdpReplying(),
      httpPost: async ({ body }) => { bodies.push(body); return '<ok/>'; },
    });
    expect(resolved?.protocol).toBe('igd');
    // The two ports DIFFER, which is the only shape that can tell them apart.
    // ⚠ THE REPLY IS NOT MODELLED AND THE REJECTION IS EXPECTED. This asserts
    // what was SENT; the stub answers `<ok/>`, which is not a SOAP envelope, so
    // the client rejects after the POST. Building a valid envelope here would
    // add a second thing to keep in step with `igd-soap` for no gain.
    await resolved!.actuator
      .unmap({ protocol: 'tcp', internalPort: 443, externalPort: 9443 })
      .catch(() => undefined);
    const deleteBody = bodies.find((b) => b.includes('DeletePortMapping'));
    expect(deleteBody, 'no DeletePortMapping was sent').toBeDefined();
    expect(
      deleteBody,
      'the delete named the INTERNAL port — it would remove a different entry',
    ).toContain('<NewExternalPort>9443</NewExternalPort>');
    expect(deleteBody).not.toContain('<NewExternalPort>443</NewExternalPort>');
  });
});

/** ⛔ THE TWO BOUNDS, PINNED BY VALUE.
 *
 *  ⚠ FOUND BY MUTATION: multiplying `IGD_DESCRIPTION_MAX_BYTES` by 1024 reddened
 *  nothing, because the size-cap tests express both the body they stream AND the
 *  bound they assert IN TERMS OF the constant — so scaling it scales the test.
 *  A self-referential test pins the RELATIONSHIP and says nothing about the
 *  magnitude, and the magnitude is the entire security property here: these
 *  bound what looking at a LAN peer's advertised URL can cost us. */
describe('D-273 — the description fetch bounds are a specific size and a specific wait', () => {
  it('⛔ the size cap is 256 KiB — not a megabyte, not a gigabyte', () => {
    expect(IGD_DESCRIPTION_MAX_BYTES).toBe(256 * 1024);
  });

  it('⛔ the timeout is 5 seconds — short enough that a silent device cannot hold boot', () => {
    expect(IGD_HTTP_TIMEOUT_MS).toBe(5000);
  });
});

/** ⛔ THE SOAP CONTROL POST IS THE SAME SSRF BOUNDARY AS THE DESCRIPTION FETCH,
 *  and it was the untested end.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18). `redirect: 'error'` on the description
 *  fetch has a test with its own mutation note; the identical guard on the
 *  control POST had none, so flipping it to `'follow'` was invisible. One rule
 *  at two ends, pinned at one — and the POST is the more attractive hop: it
 *  carries a body to a URL named inside a device description a LAN peer served.
 *  A control URL that redirects is not a router doing its job. */
describe('D-273 — the SOAP control POST is confined too', () => {
  const soapArgs = {
    url: 'http://192.168.1.1:5000/ctl',
    soapAction: '"urn:schemas-upnp-org:service:WANIPConnection:1#GetExternalIPAddress"',
    body: '<s:Envelope/>',
  };

  it('⛔⛔ refuses to FOLLOW a redirect', async () => {
    let seen: RequestInit | undefined;
    const post = createIgdHttpPost(async (_url, init) => {
      seen = init;
      return new Response('<s:Envelope/>');
    });
    await post(soapArgs).catch(() => undefined);
    expect(seen?.redirect, 'the control POST would follow a redirect off-router').toBe('error');
  });

  it('⚠ a real redirect response therefore REJECTS rather than resolving', async () => {
    // The flag is only worth having if the rejection reaches the caller: a
    // `fetch` configured this way throws on a 3xx, and that must not be
    // swallowed into an empty body that reads as a router with nothing to say.
    const post = createIgdHttpPost(async () => {
      throw new TypeError('fetch failed: unexpected redirect');
    });
    await expect(post(soapArgs)).rejects.toThrow();
  });

  it('⚠ the reply is size-capped like the description fetch', async () => {
    // Same `readCapped`, same reason: the body comes from a LAN peer.
    //
    // ⛔⛔ FINITE, AND THAT IS NOT A DETAIL. The first version of this stream
    // enqueued forever, so removing the cap did not FAIL the test — it HUNG it,
    // taking the whole suite with it and leaving a mutation run wedged with the
    // source still edited. A test that hangs on a defect is strictly worse than
    // one that fails: it reports nothing and blocks everything after it.
    // ⇒ Oversized but bounded, so a missing cap ends in a rejection that does
    // not arrive, not in a loop that never ends.
    let sent = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= IGD_DESCRIPTION_MAX_BYTES * 4) { controller.close(); return; }
        sent += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const post = createIgdHttpPost(async () => new Response(huge));
    await expect(post(soapArgs)).rejects.toThrow(/implausibly large/);
  });

  it('⚠ it carries both headers the SOAP binding requires', async () => {
    let seen: RequestInit | undefined;
    const post = createIgdHttpPost(async (_url, init) => {
      seen = init;
      return new Response('<s:Envelope/>');
    });
    await post(soapArgs).catch(() => undefined);
    const headers = seen?.headers as Record<string, string> | undefined;
    expect(headers?.['content-type']).toContain('text/xml');
    // ⚠ Already quoted by `buildSoapRequest` — forwarded verbatim, never re-quoted.
    expect(headers?.soapaction).toBe(soapArgs.soapAction);
    expect(seen?.method).toBe('POST');
  });
});

/** ⛔ A DEVICE THAT NEVER ANSWERS MUST NOT HOLD THE BOOT.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18): widening `IGD_HTTP_TIMEOUT_MS` at the call
 *  site reddened nothing. The constant's VALUE is pinned above, but nothing
 *  proved it is actually the bound the fetch is given — and detection runs with
 *  mapping switched OFF, so this path is reachable on any server with a gateway.
 *  The LOCATION comes from an SSDP reply, i.e. from whatever answered on the
 *  LAN; a blackholing responder never sends a byte and never closes.
 *
 *  ⛔⛔ THE OUTCOME IS RACED, NOT AWAITED, AND THAT IS DELIBERATE. Awaiting the
 *  rejection directly would HANG under the mutation instead of failing — which
 *  is exactly what happened earlier in this sweep: a test with an unbounded
 *  stream turned a survivable mutant into a wedged suite. A test that hangs on
 *  a defect reports nothing and blocks everything after it. */
describe('D-273 — the description fetch is bounded in TIME, not only in size', () => {
  it('⛔ aborts once the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const fetchDescription = createIgdDescriptionFetch(
        (_url, init) => new Promise<Response>((_resolve, reject) => {
          // A device that accepts the connection and then says nothing. Only
          // the abort can end this.
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      );
      const outcome = fetchDescription('http://192.168.1.1/d.xml').then(
        () => 'resolved' as const,
        () => 'aborted' as const,
      );
      await vi.advanceTimersByTimeAsync(IGD_HTTP_TIMEOUT_MS + 1);
      const settled = await Promise.race([outcome, Promise.resolve('still-pending' as const)]);
      expect(
        settled,
        'the fetch was still waiting after its timeout — a silent device holds boot',
      ).toBe('aborted');
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ─── Mutation sweep of `network/port-mapping-actuator.ts`, 2026-09-18 ──────
 *  24 mutations; 15 caught. The survivors split into two groups.
 *
 *  EQUIVALENT — three guards inside `resolvePortMappingActuator` (`found !==
 *  null`, `target !== null`, and the `fetchDescription !== undefined` half of
 *  the entry condition). Deleting any of them makes the next line throw on a
 *  null or undefined, and that throw lands in the SAME best-effort `catch` the
 *  block already has, which falls through to NAT-PMP. The OUTCOME is
 *  identical, which is why "falls back to NAT-PMP when no IGD answers" passes
 *  under every one of them. They are worth keeping — a guard that says what it
 *  means beats a throw that happens to be swallowed — but no test can tell.
 *
 *  ⛔ CLOSED 2026-09-18 — the five `createSsdpTransport` survivors. The socket
 *  factory is now a default parameter (production passes nothing, so both call
 *  sites in `compose-listeners.ts` are unchanged), and all five properties are
 *  driven through a fake socket: the multicast-interface pin, whole-window
 *  collection, error-resolves-not-rejects, the settled latch, and closing on
 *  every exit path. Five more were added while the seam was open — the bind
 *  address, the SSDP port, a send failure, and pinning the interface when none
 *  was given. 10/10 caught; see `describe('D-273 — createSsdpTransport')`.
 * ────────────────────────────────────────────────────────────────────────── */

/** D-273 — the real SSDP transport, driven through a seamed socket.
 *
 *  ⚠ FOUND BY MUTATION (2026-09-18). Five properties of `createSsdpTransport`
 *  survived every test, because the function reached for `node:dgram` itself
 *  and nothing could get at it. Each had a comment saying why it mattered and
 *  none had a case.
 *
 *  ⛔⛔ EVERY ASSERTION BELOW RACES AGAINST A SENTINEL RATHER THAN AWAITING THE
 *  SEARCH. Four of these five mutations leave the promise PENDING rather than
 *  wrong — a window that never closes, a latch that never settles — so an
 *  `await` would hang the suite instead of failing it. That already happened
 *  once in this sweep and wedged a mutation run with the source still edited.
 *  A test that hangs on a defect reports nothing and blocks everything after. */
describe('D-273 — createSsdpTransport', () => {
  const fakeSocket = () => {
    const handlers: Record<string, Array<(arg: never) => void>> = {};
    const calls = {
      multicastInterface: [] as string[],
      bound: [] as Array<{ address?: string }>,
      sent: [] as Array<{ message: string; port: number; address: string }>,
      closed: 0,
    };
    let sendCallback: ((err: Error | null) => void) | undefined;
    const socket: SsdpSocket = {
      on(event: string, listener: (arg: never) => void) {
        (handlers[event] ??= []).push(listener);
        return socket;
      },
      bind(options, callback) {
        calls.bound.push(options);
        // Async, like the real one: the send happens in the bind callback.
        queueMicrotask(callback);
        return socket;
      },
      setMulticastInterface(address) { calls.multicastInterface.push(address); },
      send(message, port, address, callback) {
        calls.sent.push({ message, port, address });
        sendCallback = callback;
      },
      close() { calls.closed += 1; },
    };
    return {
      socket,
      calls,
      reply: (text: string) => {
        for (const h of handlers.message ?? []) {
          (h as unknown as (m: { toString(e: 'utf8'): string }) => void)({ toString: () => text });
        }
      },
      fail: (err: Error) => {
        for (const h of handlers.error ?? []) (h as unknown as (e: Error) => void)(err);
      },
      completeSend: (err: Error | null = null) => sendCallback?.(err),
    };
  };

  /** Settled-or-pending, never a bare await. */
  const peek = async <T>(p: Promise<T>): Promise<T | 'pending'> => {
    const marker = Symbol('pending');
    const raced = await Promise.race([
      p,
      Promise.resolve(marker as unknown as T),
    ]);
    return (raced as unknown) === marker ? 'pending' : raced;
  };

  const search = (fake: ReturnType<typeof fakeSocket>, bindAddress?: string) =>
    createSsdpTransport(() => fake.socket).search({
      message: 'M-SEARCH * HTTP/1.1',
      windowMs: 2000,
      ...(bindAddress !== undefined ? { bindAddress } : {}),
    });

  it('⛔⛔ pins the multicast interface to THIS machine’s address', async () => {
    // ⛔ Binding alone does not decide which interface multicast LEAVES by on
    // every platform. A host with a Docker bridge, a VPN and a real LAN sends
    // the search out the wrong one, and the module's own comment names the
    // result: indistinguishable from a router with no UPnP. That is the most
    // expensive kind of failure — the feature simply never works, on exactly
    // the multi-homed hosts most likely to run a server.
    vi.useFakeTimers();
    try {
      const fake = fakeSocket();
      const p = search(fake, '192.168.1.42');
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.calls.multicastInterface).toEqual(['192.168.1.42']);
      expect(fake.calls.bound[0]).toEqual({ address: '192.168.1.42' });
      expect(fake.calls.sent[0]).toMatchObject({ port: 1900, address: '239.255.255.250' });
      await vi.advanceTimersByTimeAsync(2001);
      await p;
    } finally { vi.useRealTimers(); }
  });

  it('⚠ with no bind address it binds anywhere and pins nothing', async () => {
    // The complement: `setMulticastInterface` on a host that named no address
    // would throw, and the catch would turn an ordinary search into silence.
    vi.useFakeTimers();
    try {
      const fake = fakeSocket();
      const p = search(fake);
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.calls.multicastInterface).toEqual([]);
      expect(fake.calls.bound[0]).toEqual({});
      await vi.advanceTimersByTimeAsync(2001);
      await p;
    } finally { vi.useRealTimers(); }
  });

  it('⛔⛔ collects for the WHOLE window — the first reply is not the answer', async () => {
    // ⛔ Devices spread answers randomly across MX to avoid a stampede, so the
    // first arrival is not necessarily the router: a printer or a media server
    // answering `ssdp:all` is often quicker. Resolving on the first reply picks
    // whoever was fastest and calls it the gateway.
    vi.useFakeTimers();
    try {
      const fake = fakeSocket();
      const p = search(fake, '192.168.1.42');
      await vi.advanceTimersByTimeAsync(0);
      fake.reply('HTTP/1.1 200 OK\r\nST: printer\r\n');
      await vi.advanceTimersByTimeAsync(100);
      expect(
        await peek(p),
        'the search resolved on the first reply — a printer would win',
      ).toBe('pending');

      fake.reply('HTTP/1.1 200 OK\r\nST: InternetGatewayDevice\r\n');
      await vi.advanceTimersByTimeAsync(2001);
      const replies = await peek(p);
      expect(replies, 'the window closed but the search never settled').not.toBe('pending');
      expect(replies).toHaveLength(2);
      expect((replies as readonly string[])[1]).toContain('InternetGatewayDevice');
    } finally { vi.useRealTimers(); }
  });

  it('⛔ a socket ERROR resolves with what arrived — silence is an answer, not a failure', async () => {
    // ⛔ A network with no IGD is the ORDINARY case. Rejecting would turn it
    // into an exception on a path that runs at boot with mapping switched off.
    vi.useFakeTimers();
    try {
      const fake = fakeSocket();
      const p = search(fake, '192.168.1.42');
      await vi.advanceTimersByTimeAsync(0);
      fake.reply('HTTP/1.1 200 OK\r\nST: one\r\n');
      fake.fail(new Error('EHOSTUNREACH'));
      const replies = await peek(p);
      expect(replies, 'a socket error left the search pending').not.toBe('pending');
      expect(replies).toHaveLength(1);
      expect(fake.calls.closed, 'the socket was not closed on the error path').toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('⛔ a send failure ends the search rather than waiting out the window', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSocket();
      const p = search(fake, '192.168.1.42');
      await vi.advanceTimersByTimeAsync(0);
      fake.completeSend(new Error('ENETDOWN'));
      expect(await peek(p), 'a failed send left the search pending').not.toBe('pending');
      expect(fake.calls.closed).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('⛔⛔ settles ONCE and closes ONCE, however many endings arrive', async () => {
    // ⛔ The latch is the only thing between "an error arrived after the window
    // closed" and a double close on a socket that is already gone — and the
    // real socket throws on that, inside a callback nothing awaits.
    vi.useFakeTimers();
    try {
      const fake = fakeSocket();
      const p = search(fake, '192.168.1.42');
      await vi.advanceTimersByTimeAsync(0);
      fake.reply('HTTP/1.1 200 OK\r\nST: one\r\n');

      fake.fail(new Error('first'));
      fake.fail(new Error('second'));
      fake.completeSend(new Error('third'));
      await vi.advanceTimersByTimeAsync(2001);

      expect(fake.calls.closed, 'the socket was closed more than once').toBe(1);
      const replies = await peek(p);
      expect(replies).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('⛔ closes the socket on the ordinary timeout path too', async () => {
    // The path every quiet network takes. A transport that leaks a UDP socket
    // per detection leaks one every reconcile, for the life of the process.
    vi.useFakeTimers();
    try {
      const fake = fakeSocket();
      const p = search(fake, '192.168.1.42');
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.calls.closed).toBe(0);
      await vi.advanceTimersByTimeAsync(2001);
      expect(await peek(p), 'the window elapsed but the search never settled').not.toBe('pending');
      expect(fake.calls.closed, 'the socket outlived its search').toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

