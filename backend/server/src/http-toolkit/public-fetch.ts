/** D-345 slice A — a fetch of a public web address, for the HTTP Toolkit.
 *
 *  The owner: "download a file, it can go to server path if it is an open url right". The server
 *  fetches an address the model names, so the address must not reach what only the server can reach:
 *  its own ports, the owner's network, a cloud's metadata service. Every address the name resolves
 *  to must be public (`isPublicAddress`), the connection goes to the address that was checked (a name
 *  that resolves one way for the check and another for the fetch is the rebinding hole), each
 *  redirect is checked again, and nothing of the owner's rides along: no cookies, no credentials.
 *  Bounded in bytes (decompressed bytes counted) and in time. */
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/** Why a fetch did not answer. */
export type PublicFetchFailure = 'bad_address' | 'not_public' | 'too_many_redirects' | 'too_large' | 'timeout' | 'failed';

export class PublicFetchError extends Error {
  constructor(readonly code: PublicFetchFailure, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PublicFetchError';
  }
}

/** One resolved address of a name. */
export interface ResolvedAddress { readonly address: string; readonly family: 4 | 6 }

export interface PublicFetchOptions {
  readonly method?: 'GET' | 'HEAD';
  /** The most body bytes, decompressed, the fetch keeps. */
  readonly maxBytes: number;
  /** Past `maxBytes`: keep the first `maxBytes` and say so, or fail `too_large`. */
  readonly overflow: 'truncate' | 'fail';
  /** The whole exchange, redirects included. */
  readonly timeoutMs: number;
  readonly accept?: string;
  readonly userAgent?: string;
  /** At most this many redirects (default 5). */
  readonly maxRedirects?: number;
  /** The resolver: every address of a name (default: the system's, all of them). */
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  /** ⛔ Tests only: an address treated as public, so a local server can stand in for a site. */
  readonly treatAsPublic?: (address: string) => boolean;
}

export interface PublicFetchResult {
  /** The address that answered, after redirects. */
  readonly url: string;
  readonly status: number;
  readonly status_text: string;
  /** Its headers, names lower-cased, `set-cookie` left out. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body, decompressed, at most `maxBytes` (empty for `HEAD`). */
  readonly body: Buffer;
  /** True when the body went past `maxBytes` and was cut there. */
  readonly truncated: boolean;
  /** Each address redirected through, in order. */
  readonly redirects: readonly string[];
}

/** Addresses no fetch may reach: what is not on the public internet.
 *
 *  ⚠ NOT 198.18.0.0/15 (set aside for benchmarking). A proxy in fake-IP mode (Clash, Surge, sing-box)
 *  answers every name with an address there and connects to the real site itself: on the owner's Mac
 *  (2026-11-07) www.w3.org resolved to 198.18.13.163, and refusing the range refused every fetch.
 *  Behind such a proxy this check sees the proxy's address, not the site's: where it connects is the
 *  proxy's rules' to decide. */
const NOT_PUBLIC = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ] as const) list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of [
    ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
    ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ] as const) list.addSubnet(net, prefix, 'ipv6');
  return list;
})();

/** The IPv4 address an IPv6 address carries, for the forms that carry one: IPv4-mapped
 *  (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`) and NAT64's well-known prefix (`64:ff9b::/96`). */
const embeddedIpv4 = (address: string): string | undefined => {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return undefined;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
};

/** Whether an IP address is on the public internet. */
export const isPublicAddress = (address: string): boolean => {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(bare);
  if (family === 4) return !NOT_PUBLIC.check(bare, 'ipv4');
  if (family !== 6) return false;
  const inner = embeddedIpv4(bare);
  if (inner !== undefined) return isIP(inner) === 4 && !NOT_PUBLIC.check(inner, 'ipv4');
  return !NOT_PUBLIC.check(bare, 'ipv6');
};

const systemResolve = async (hostname: string): Promise<readonly ResolvedAddress[]> =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

/** The address to connect to for `url`'s host: every address its name resolves to must be public,
 *  and the first is the one connected to. */
const vetHost = async (url: URL, options: PublicFetchOptions): Promise<ResolvedAddress> => {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const isPublic = (address: string) => options.treatAsPublic?.(address) === true || isPublicAddress(address);
  const literal = isIP(host);
  if (literal !== 0) {
    if (!isPublic(host)) throw new PublicFetchError('not_public', `${url.host} is not a public address.`, { host: url.host });
    return { address: host, family: literal === 6 ? 6 : 4 };
  }
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
    throw new PublicFetchError('not_public', `${url.host} is not a public address.`, { host: url.host });
  }
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await (options.resolve ?? systemResolve)(host);
  } catch (error) {
    throw new PublicFetchError('failed', `${url.host} could not be found: ${error instanceof Error ? error.message : String(error)}`,
      { host: url.host });
  }
  if (addresses.length === 0) throw new PublicFetchError('failed', `${url.host} could not be found.`, { host: url.host });
  const inner = addresses.find((a) => !isPublic(a.address));
  if (inner !== undefined) {
    throw new PublicFetchError('not_public', `${url.host} leads to an address that is not public (${inner.address}).`,
      { host: url.host, address: inner.address });
  }
  return addresses[0]!;
};

/** An address the fetch may start from or be redirected to: `http` or `https`, no credentials in it. */
const parseAddress = (raw: string, base?: string): URL => {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    throw new PublicFetchError('bad_address', `${raw} is not a web address.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PublicFetchError('bad_address', `${url.href} is not an http or https address.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new PublicFetchError('bad_address', 'An address with a name and password in it is not fetched.');
  }
  url.hash = '';
  return url;
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** One request to `url`, connected to `to`, answered with its status, headers and response stream. */
const requestOnce = (url: URL, to: ResolvedAddress, method: 'GET' | 'HEAD', headers: Record<string, string>,
  signal: AbortSignal): Promise<http.IncomingMessage> => new Promise((resolve, reject) => {
  // The connection goes to the checked address, whatever the name resolves to now.
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all === true) {
      (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null,
        [{ address: to.address, family: to.family }]);
    } else {
      callback(null, to.address, to.family);
    }
  };
  const client = url.protocol === 'https:' ? https : http;
  const request = client.request(url, { method, headers, lookup: pinned, signal, agent: false });
  request.on('response', resolve);
  request.on('error', reject);
  request.end();
});

/** The response body, decompressed, at most `maxBytes`. */
const readBody = async (response: http.IncomingMessage, options: PublicFetchOptions): Promise<{ body: Buffer; truncated: boolean }> => {
  const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
  let stream: Readable = response;
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(createGunzip());
  else if (encoding === 'deflate') stream = response.pipe(createInflate());
  else if (encoding === 'br') stream = response.pipe(createBrotliDecompress());
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const part = chunk as Buffer;
      if (size + part.length > options.maxBytes) {
        if (options.overflow === 'fail') {
          throw new PublicFetchError('too_large', `The answer is larger than ${String(options.maxBytes)} bytes.`,
            { max_bytes: options.maxBytes });
        }
        parts.push(part.subarray(0, options.maxBytes - size));
        return { body: Buffer.concat(parts), truncated: true };
      }
      parts.push(part);
      size += part.length;
    }
  } finally {
    response.destroy();
  }
  return { body: Buffer.concat(parts), truncated: false };
};

/** Fetch `address`, a public web address. */
export const publicFetch = async (address: string, options: PublicFetchOptions): Promise<PublicFetchResult> => {
  const method = options.method ?? 'GET';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const redirects: string[] = [];
  let url = parseAddress(address);
  try {
    for (;;) {
      const to = await vetHost(url, options);
      const headers: Record<string, string> = {
        'user-agent': options.userAgent ?? 'Recued (+https://recued.com)',
        accept: options.accept ?? '*/*',
        'accept-encoding': 'gzip, deflate, br',
      };
      let response: http.IncomingMessage;
      try {
        response = await requestOnce(url, to, method, headers, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw new PublicFetchError('timeout', `${url.host} did not answer in time.`, { host: url.host });
        throw new PublicFetchError('failed', `${url.host} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
          { host: url.host });
      }
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (REDIRECTS.has(status) && typeof location === 'string' && location !== '') {
        response.resume();
        if (redirects.length >= (options.maxRedirects ?? 5)) {
          throw new PublicFetchError('too_many_redirects', `${address} redirected more than ${String(options.maxRedirects ?? 5)} times.`);
        }
        url = parseAddress(location, url.href);
        redirects.push(url.href);
        continue;
      }
      const kept: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (name === 'set-cookie' || value === undefined) continue;
        kept[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      let read: { body: Buffer; truncated: boolean } = { body: Buffer.alloc(0), truncated: false };
      if (method === 'HEAD') {
        response.resume();
      } else {
        try {
          read = await readBody(response, options);
        } catch (error) {
          if (error instanceof PublicFetchError) throw error;
          if (controller.signal.aborted) throw new PublicFetchError('timeout', `${url.host} did not finish answering in time.`, { host: url.host });
          throw new PublicFetchError('failed', `The answer from ${url.host} could not be read: ${error instanceof Error ? error.message : String(error)}`,
            { host: url.host });
        }
      }
      return { url: url.href, status, status_text: response.statusMessage ?? '', headers: kept, body: read.body,
        truncated: read.truncated, redirects };
    }
  } finally {
    clearTimeout(timer);
  }
};
