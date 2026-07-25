/** R26.2 Option B — self-serve OAuth opener-relay page tests.
 *
 *  Covers the pure decision (`evaluateOpenerRelay`) + the DOM bootstrap
 *  (`runOAuthCallbackRelay`) in `connections/oauth-callback-relay.ts`. The
 *  relay HARDCODES its protocol constants (so it bundles as a ~2 KB standalone
 *  asset rather than dragging the contracts barrel in); these tests drive it
 *  using the CONTRACT constants, so any drift between the hardcoded copies and
 *  the source of truth fails here. */

import { describe, it, expect } from 'vitest';
import {
  OPENER_RELAY_MESSAGE_KIND,
  OAUTH_OPENER_RELAY_PARAM,
  OAUTH_OPENER_RELAY_VALUE,
  OAUTH_OPENER_RELAY_STATE_PREFIX,
  WEBCLIENT_OAUTH_CALLBACK_PATH,
} from '@recued/contracts';
import {
  evaluateOpenerRelay,
  runOAuthCallbackRelay,
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
