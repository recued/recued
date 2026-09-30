/** R26.2 Option B — self-serve OAuth opener-relay page tests.
 *
 *  Covers the pure decision (`evaluateOpenerRelay`) + the DOM bootstrap
 *  (`runOAuthCallbackRelay`) in `connections/oauth-callback-relay.ts`. The
 *  relay HARDCODES its protocol constants (so it bundles as a ~2 KB standalone
 *  asset rather than dragging the contracts barrel in); these tests drive it
 *  using the CONTRACT constants, so any drift between the hardcoded copies and
 *  the source of truth fails here. */

import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import {
  OPENER_RELAY_MESSAGE_KIND,
  OAUTH_CLOUD_CALLBACK_URL,
  OAUTH_OPENER_ORIGIN_PARAM,
  OAUTH_OPENER_RELAY_PARAM,
  OAUTH_OPENER_RELAY_VALUE,
  OAUTH_OPENER_RELAY_STATE_PREFIX,
  WEBCLIENT_OAUTH_CALLBACK_PATH,
  readOpenerRelayTarget,
} from '@recued/contracts';
import {
  completeVendorCallback,
  evaluateOpenerRelay,
  readCallbackParams,
  resolveOpenerRelayTarget,
  runOAuthCallbackRelay,
  type VendorCallbackDeps,
} from '../connections/oauth-callback-relay.js';

const STATE = OAUTH_OPENER_RELAY_STATE_PREFIX + 'nonce-abc';

/** Build a callback query string from the CONTRACT constants. */
const query = (extra: Record<string, string>): URLSearchParams =>
  new URLSearchParams({
    [OAUTH_OPENER_RELAY_PARAM]: OAUTH_OPENER_RELAY_VALUE,
    state: STATE,
    ...extra,
  });

interface FakeWin {
  win: Window;
  posted: Array<{ msg: unknown; target: string }>;
  replaced: string[];
  els: Record<string, { textContent: string; className: string }>;
  closeCalls: () => number;
}

const makeWin = (href: string, opts?: { opener?: boolean }): FakeWin => {
  const posted: Array<{ msg: unknown; target: string }> = [];
  const replaced: string[] = [];
  let closeCount = 0;
  const els: Record<string, { textContent: string; className: string }> = {
    status: { textContent: '', className: '' },
    message: { textContent: '', className: '' },
  };
  const origin = new URL(href).origin;
  const win = {
    location: { href, origin },
    history: {
      replaceState: (_s: unknown, _t: string, url?: string | URL | null) => {
        replaced.push(String(url));
      },
    },
    opener:
      opts?.opener === false
        ? null
        : { postMessage: (msg: unknown, target: string) => posted.push({ msg, target }) },
    document: { getElementById: (id: string) => els[id] ?? null },
    close: () => { closeCount += 1; },
  } as unknown as Window;
  return { win, posted, replaced, els, closeCalls: () => closeCount };
};

describe('evaluateOpenerRelay (pure decision — drift-guarded by contract constants)', () => {
  it('relays the code on a well-formed callback', () => {
    const out = evaluateOpenerRelay(query({ code: 'auth-code-123' }));
    expect(out.status).toBe('ok');
    expect(out.message).toEqual({
      kind: OPENER_RELAY_MESSAGE_KIND,
      state: STATE,
      code: 'auth-code-123',
    });
  });

  it('relays a provider error', () => {
    const out = evaluateOpenerRelay(query({ error: 'access_denied' }));
    expect(out.status).toBe('provider_error');
    expect(out.message).toEqual({
      kind: OPENER_RELAY_MESSAGE_KIND,
      state: STATE,
      error: 'access_denied',
    });
  });

  it('reports missing_code (still relays an empty code; the opener ignores it)', () => {
    const out = evaluateOpenerRelay(query({}));
    expect(out.status).toBe('missing_code');
    expect(out.message).toEqual({ kind: OPENER_RELAY_MESSAGE_KIND, state: STATE, code: '' });
  });

  it('relays WITHOUT the recued_relay marker when the frelay_ state prefix is present (Microsoft)', () => {
    // Microsoft Entra forbids query strings in redirect URIs, so the graph flow
    // omits the marker; the frelay_ state prefix is the family gate (the opener
    // still verifies the FULL state for CSRF).
    const params = new URLSearchParams({ state: STATE, code: 'x' }); // no recued_relay
    const out = evaluateOpenerRelay(params);
    expect(out.status).toBe('ok');
    expect(out.message).toEqual({ kind: OPENER_RELAY_MESSAGE_KIND, state: STATE, code: 'x' });
  });

  it('is fail-closed: state without the foundational prefix → invalid', () => {
    const params = new URLSearchParams({
      [OAUTH_OPENER_RELAY_PARAM]: OAUTH_OPENER_RELAY_VALUE,
      state: 'not-a-frelay-state',
      code: 'x',
    });
    const out = evaluateOpenerRelay(params);
    expect(out.status).toBe('invalid');
    expect(out.message).toBeNull();
  });
});

describe('runOAuthCallbackRelay (DOM bootstrap)', () => {
  const LOOPBACK = 'http://localhost:8787';
  const href = (q: URLSearchParams): string =>
    `${LOOPBACK}${WEBCLIENT_OAUTH_CALLBACK_PATH}?${q.toString()}`;

  it('posts the code to the opener at the SAME origin (never "*") and scrubs the URL', () => {
    const { win, posted, replaced, els } = makeWin(href(query({ code: 'abc' })));
    runOAuthCallbackRelay(win);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.msg).toEqual({ kind: OPENER_RELAY_MESSAGE_KIND, state: STATE, code: 'abc' });
    // Same-origin target — the loopback PWA's own origin, NOT a wildcard.
    expect(posted[0]!.target).toBe(LOOPBACK);
    // History scrubbed to the bundle path (drift-guards WEBCLIENT_OAUTH_CALLBACK_PATH).
    expect(replaced).toContain(WEBCLIENT_OAUTH_CALLBACK_PATH);
    expect(els.status.className).toBe('ok');
  });

  it('relays a provider error with an error status', () => {
    const { win, posted, els } = makeWin(href(query({ error: 'access_denied' })));
    runOAuthCallbackRelay(win);
    expect(posted[0]!.msg).toMatchObject({ error: 'access_denied' });
    expect(els.status.className).toBe('err');
  });

  it('posts nothing on an invalid (non-foundational state) load but still scrubs', () => {
    const { win, posted, replaced } = makeWin(
      `${LOOPBACK}${WEBCLIENT_OAUTH_CALLBACK_PATH}?state=not-a-frelay-state&code=x`,
    );
    runOAuthCallbackRelay(win);
    expect(posted).toHaveLength(0);
    expect(replaced).toContain(WEBCLIENT_OAUTH_CALLBACK_PATH);
  });

  it('does not throw when there is no opener', () => {
    const { win, posted } = makeWin(href(query({ code: 'abc' })), { opener: false });
    expect(() => runOAuthCallbackRelay(win)).not.toThrow();
    expect(posted).toHaveLength(0);
  });

  it('self-closes after relaying to the opener (so the opener needn\'t close it across COOP)', () => {
    const { win, posted, closeCalls } = makeWin(href(query({ code: 'abc' })));
    runOAuthCallbackRelay(win);
    expect(posted).toHaveLength(1);
    expect(closeCalls()).toBe(1);
  });

  it('does NOT self-close when there is no opener (page opened directly)', () => {
    const { win, closeCalls } = makeWin(href(query({ code: 'abc' })), { opener: false });
    runOAuthCallbackRelay(win);
    expect(closeCalls()).toBe(0);
  });

  it('does NOT self-close on an invalid (non-foundational state) load', () => {
    const { win, closeCalls } = makeWin(
      `${LOOPBACK}${WEBCLIENT_OAUTH_CALLBACK_PATH}?state=not-a-frelay-state&code=x`,
    );
    runOAuthCallbackRelay(win);
    expect(closeCalls()).toBe(0);
  });

  it('relays + self-closes WITHOUT the recued_relay marker (Microsoft) when the frelay_ state is present', () => {
    const { win, posted, closeCalls } = makeWin(
      `${LOOPBACK}${WEBCLIENT_OAUTH_CALLBACK_PATH}?state=${STATE}&code=x`, // no marker
    );
    runOAuthCallbackRelay(win);
    expect(posted).toHaveLength(1);
    expect(closeCalls()).toBe(1);
  });
});

/** ⛔⛔ app.recued.com serves this same page at /oauth-callback (since the
 *  webclient took that domain over, 2026-07-01), where it silently replaced the
 *  D-148 § A.12 page and dropped the two jobs only that host is given. The
 *  cases below are ported from that page's runtime tests
 *  (`backend/api/src/__tests__/oauth-callback-runtime.test.ts`). */
const CLOUD = new URL(OAUTH_CLOUD_CALLBACK_URL).origin;
const cloudHref = (q: URLSearchParams | string): string =>
  `${OAUTH_CLOUD_CALLBACK_URL}?${q.toString()}`;

describe('opener_origin (R26.2 Option A) — the page on app.recued.com', () => {
  const OPENER = 'https://192.168.1.50:8443';
  const withOpener = (extra: Record<string, string>): URLSearchParams =>
    query({ [OAUTH_OPENER_ORIGIN_PARAM]: OPENER, ...extra });

  it('posts the code to the cross-origin opener it names, and nowhere else', () => {
    const { win, posted, closeCalls } = makeWin(cloudHref(withOpener({ code: 'abc' })));
    void runOAuthCallbackRelay(win);
    expect(posted).toEqual([{
      msg: { kind: OPENER_RELAY_MESSAGE_KIND, state: STATE, code: 'abc' },
      target: OPENER,
    }]);
    expect(closeCalls()).toBe(1);
  });

  it('relays a provider error to that opener too (still no code)', () => {
    const { win, posted } = makeWin(cloudHref(withOpener({ error: 'access_denied' })));
    void runOAuthCallbackRelay(win);
    expect(posted[0]!.target).toBe(OPENER);
    expect(posted[0]!.msg).toEqual({ kind: OPENER_RELAY_MESSAGE_KIND, state: STATE, error: 'access_denied' });
  });

  it('without the relay marker an opener_origin is never read (Microsoft): own origin', () => {
    const q = new URLSearchParams({ state: STATE, code: 'abc', [OAUTH_OPENER_ORIGIN_PARAM]: OPENER });
    const { win, posted } = makeWin(cloudHref(q));
    void runOAuthCallbackRelay(win);
    expect(posted[0]!.target).toBe(CLOUD);
  });

  it('falls back to its own origin for any opener_origin that is not a canonical http(s) origin', () => {
    for (const bad of [
      'not a url',
      'javascript:alert(1)',
      'https://good.example@evil.example', // userinfo — host confusion
      'https://alice.recued.net/', // a path, not a bare origin
      'HTTPS://ALICE.RECUED.NET', // not canonical
      '',
    ]) {
      const { win, posted } = makeWin(cloudHref(query({ code: 'abc', [OAUTH_OPENER_ORIGIN_PARAM]: bad })));
      void runOAuthCallbackRelay(win);
      expect(posted[0]!.target, bad).toBe(CLOUD);
    }
  });

  it('follows the contract rule exactly (drift guard against readOpenerRelayTarget)', () => {
    for (const value of [OPENER, 'http://192.168.1.5:7717', 'https://a@b.example', 'ftp://x.example', 'https://x.example/p']) {
      const q = query({ [OAUTH_OPENER_ORIGIN_PARAM]: value });
      expect(resolveOpenerRelayTarget(q, CLOUD), value).toBe(readOpenerRelayTarget(q) ?? CLOUD);
    }
  });

  it('scrubs the address to its own path on this host, not the server bundle path', () => {
    const { win, replaced } = makeWin(cloudHref(withOpener({ code: 'abc' })));
    void runOAuthCallbackRelay(win);
    expect(replaced).toEqual([new URL(OAUTH_CLOUD_CALLBACK_URL).pathname]);
  });

  it('takes a code that arrives in the fragment', () => {
    const { win, posted } = makeWin(`${OAUTH_CLOUD_CALLBACK_URL}#state=${STATE}&code=frag-code`);
    void runOAuthCallbackRelay(win);
    expect(posted[0]!.msg).toMatchObject({ code: 'frag-code' });
    expect(readCallbackParams(`${OAUTH_CLOUD_CALLBACK_URL}?code=q#code=f`).get('code')).toBe('q');
  });
});

// ── The vendor flow (HubSpot, Salesforce, any BYO OAuth app) ─────────────

const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const sortKeys = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));

const signState = (
  privateKey: KeyObject,
  payload: Record<string, unknown>,
  opts: { tamperSignature?: boolean } = {},
): string => {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(sortKeys(payload)));
  const signature = nodeSign(null, payloadBytes, privateKey);
  if (opts.tamperSignature) signature[0] = signature[0]! ^ 0xff;
  return `${b64url(payloadBytes)}.${b64url(signature)}`;
};

const NOW = 1_800_000_000_000;
const SERVER = 'https://alice.recued.net';

const vendorFixture = (opts: {
  payload?: Record<string, unknown>;
  tamperSignature?: boolean;
  signWith?: 'other-key';
  storeKey?: boolean;
  fetchOk?: boolean;
  fetchThrows?: boolean;
  events?: string[];
} = {}) => {
  const keys = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const payload = opts.payload ?? { server_url: SERVER, flow_id: 'flow-1', ts: NOW - 1000 };
  const state = signState(
    opts.signWith === 'other-key' ? other.privateKey : keys.privateKey,
    payload,
    { tamperSignature: opts.tamperSignature },
  );
  const spki = keys.publicKey.export({ type: 'spki', format: 'der' });
  const store = new Map<string, string>();
  if (opts.storeKey !== false) store.set(`oauth_jwks_${String(payload.flow_id)}`, b64url(spki));
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    opts.events?.push('fetch');
    void url;
    void init;
    if (opts.fetchThrows) throw new TypeError('Failed to fetch');
    return { ok: opts.fetchOk !== false, status: opts.fetchOk === false ? 500 : 200 };
  });
  const deps: VendorCallbackDeps = {
    getItem: (k) => store.get(k) ?? null,
    subtle: globalThis.crypto.subtle,
    fetch: fetchMock,
    now: () => NOW,
  };
  return { state, deps, fetchMock };
};

describe('vendor flow — the page on app.recued.com verifies, then hands the code to your server', () => {
  it('a valid signed state POSTs { code, state, flow_id } to <server_url>/oauth/complete', async () => {
    const { state, deps, fetchMock } = vendorFixture();
    const { win, posted, els, closeCalls } = makeWin(cloudHref(new URLSearchParams({ code: 'c0de', state })));
    await runOAuthCallbackRelay(win, deps);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${SERVER}/oauth/complete`);
    expect(init).toMatchObject({ method: 'POST', mode: 'cors' });
    expect(JSON.parse(String(init.body))).toEqual({ code: 'c0de', state, flow_id: 'flow-1' });
    expect(els.status.textContent).toBe('Sign-in complete.');
    // Not a relay: nothing goes to the opener, and the page does not close itself.
    expect(posted).toHaveLength(0);
    expect(closeCalls()).toBe(0);
  });

  it('forwards a QuickBooks realmId, and sends none when the callback has none', async () => {
    const withRealm = vendorFixture();
    await runOAuthCallbackRelay(
      makeWin(cloudHref(new URLSearchParams({ code: 'c', state: withRealm.state, realmId: '9130' }))).win,
      withRealm.deps,
    );
    expect(JSON.parse(String(withRealm.fetchMock.mock.calls[0]![1].body))).toMatchObject({ realmId: '9130' });
    const without = vendorFixture();
    await runOAuthCallbackRelay(makeWin(cloudHref(new URLSearchParams({ code: 'c', state: without.state }))).win, without.deps);
    expect(JSON.parse(String(without.fetchMock.mock.calls[0]![1].body))).not.toHaveProperty('realmId');
  });

  it('sends nothing for a forged signature, a key it did not sign with, or no stored key', async () => {
    for (const [label, fixture] of [
      ['forged', vendorFixture({ tamperSignature: true })],
      ['other key', vendorFixture({ signWith: 'other-key' })],
      ['no key', vendorFixture({ storeKey: false })],
    ] as const) {
      const { win, els } = makeWin(cloudHref(new URLSearchParams({ code: 'c', state: fixture.state })));
      await runOAuthCallbackRelay(win, fixture.deps);
      expect(fixture.fetchMock, label).not.toHaveBeenCalled();
      expect(els.status.className, label).toBe('err');
    }
  });

  it('sends nothing for a stale or a future-dated state', async () => {
    for (const ts of [NOW - 5 * 60 * 1000 - 1, NOW + 1]) {
      const fixture = vendorFixture({ payload: { server_url: SERVER, flow_id: 'flow-1', ts } });
      const { win, els } = makeWin(cloudHref(new URLSearchParams({ code: 'c', state: fixture.state })));
      await runOAuthCallbackRelay(win, fixture.deps);
      expect(fixture.fetchMock, String(ts)).not.toHaveBeenCalled();
      expect(els.status.textContent).toBe('This sign-in took too long.');
    }
  });

  it('sends nothing for a malformed state', async () => {
    const fixture = vendorFixture();
    for (const state of ['one-part', 'a.b.c', '.x', 'x.', '!!!.!!!']) {
      expect((await completeVendorCallback({ code: 'c', state, realmId: null }, fixture.deps)).status, state)
        .toBe('vendor_malformed');
    }
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it('says so when the server refuses it or cannot be reached', async () => {
    const refused = vendorFixture({ fetchOk: false });
    const r = makeWin(cloudHref(new URLSearchParams({ code: 'c', state: refused.state })));
    await runOAuthCallbackRelay(r.win, refused.deps);
    expect(r.els.status.textContent).toBe('Your Recued server did not accept the sign-in.');
    expect(r.els.message.textContent).toContain('500');
    const down = vendorFixture({ fetchThrows: true });
    const d = makeWin(cloudHref(new URLSearchParams({ code: 'c', state: down.state })));
    await runOAuthCallbackRelay(d.win, down.deps);
    expect(d.els.status.textContent).toBe('Your Recued server could not be reached.');
  });

  it('a browser that cannot check the key is not told the state was forged', async () => {
    const fixture = vendorFixture();
    const broken: VendorCallbackDeps = {
      ...fixture.deps,
      subtle: {
        importKey: () => Promise.reject(new Error('NotSupportedError')),
        verify: () => Promise.reject(new Error('unreachable')),
      },
    };
    expect((await completeVendorCallback({ code: 'c', state: fixture.state, realmId: null }, broken)).status)
      .toBe('vendor_check_failed');
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it('scrubs the code from the address bar BEFORE it posts it anywhere', async () => {
    const events: string[] = [];
    const fixture = vendorFixture({ events });
    const { win } = makeWin(cloudHref(new URLSearchParams({ code: 'c', state: fixture.state })));
    const replaceState = win.history.replaceState.bind(win.history);
    (win.history as { replaceState: History['replaceState'] }).replaceState = (...args) => {
      events.push('scrub');
      replaceState(...args);
    };
    await runOAuthCallbackRelay(win, fixture.deps);
    expect(events).toEqual(['scrub', 'fetch']);
  });

  it('a provider error or a missing code sends nothing', async () => {
    const fixture = vendorFixture();
    for (const q of [
      new URLSearchParams({ error: 'access_denied', state: fixture.state }),
      new URLSearchParams({ state: fixture.state }),
    ]) {
      await runOAuthCallbackRelay(makeWin(cloudHref(q)).win, fixture.deps);
    }
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });
});
