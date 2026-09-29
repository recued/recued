/** D-174 Slice 2b — foundational-lane OAuth authorize-URL builders + the
 *  opener-relay callback contract. */

import { describe, expect, it } from 'vitest';

import {
  buildMailAuthorizeUrl,
  buildCalendarAuthorizeUrl,
  buildOpenerRelayRedirectUri,
  readOpenerRelayTarget,
  pickOAuthCallbackHost,
  isLoopbackOrigin,
  gmailScopes,
  graphMailScopes,
  gcalScopes,
  graphCalendarScopes,
  isOpenerRelayCallback,
  OAUTH_OPENER_RELAY_PARAM,
  OAUTH_OPENER_RELAY_VALUE,
  OAUTH_OPENER_ORIGIN_PARAM,
  OAUTH_OPENER_RELAY_STATE_PREFIX,
  OAUTH_CLOUD_CALLBACK_ORIGIN,
  OAUTH_CLOUD_CALLBACK_URL,
  alternateOAuthCallbackUrl,
  oauthCallbackUrlForPwa,
  WEBCLIENT_OAUTH_CALLBACK_PATH,
  WEBCLIENT_PATH_PREFIX,
  GOOGLE_AUTHORIZE_URL,
  MICROSOFT_AUTHORIZE_URL,
} from '../index.js';

const BASE = {
  client_id: 'client-123.apps.googleusercontent.com',
  redirect_uri:
    'https://app.recued.com/oauth-callback?recued_relay=opener',
  state: 'nonce-abc',
};

const scopeSet = (url: string): Set<string> =>
  new Set((new URL(url).searchParams.get('scope') ?? '').split(' '));

describe('buildMailAuthorizeUrl — gmail', () => {
  it('targets the Google endpoint with the fixed query shape', () => {
    const u = new URL(buildMailAuthorizeUrl('gmail', { ...BASE, send_enabled: false }));
    expect(`${u.origin}${u.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(BASE.client_id);
    expect(u.searchParams.get('redirect_uri')).toBe(BASE.redirect_uri);
    expect(u.searchParams.get('state')).toBe('nonce-abc');
    // Google refresh-token reliability — both mandatory.
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    // Google flow does not set response_mode.
    expect(u.searchParams.get('response_mode')).toBeNull();
  });

  it('omits gmail.send when send is off, includes it when on', () => {
    const off = scopeSet(buildMailAuthorizeUrl('gmail', { ...BASE, send_enabled: false }));
    expect(off.has('https://www.googleapis.com/auth/gmail.readonly')).toBe(true);
    expect(off.has('https://www.googleapis.com/auth/userinfo.email')).toBe(true);
    expect(off.has('https://www.googleapis.com/auth/gmail.send')).toBe(false);

    const on = scopeSet(buildMailAuthorizeUrl('gmail', { ...BASE, send_enabled: true }));
    expect(on.has('https://www.googleapis.com/auth/gmail.send')).toBe(true);
  });

  it('preserves the opener-relay marker on the redirect_uri', () => {
    const u = new URL(buildMailAuthorizeUrl('gmail', { ...BASE, send_enabled: false }));
    const redirect = new URL(u.searchParams.get('redirect_uri')!);
    expect(redirect.searchParams.get(OAUTH_OPENER_RELAY_PARAM)).toBe(
      OAUTH_OPENER_RELAY_VALUE,
    );
  });
});

describe('buildMailAuthorizeUrl — graph', () => {
  it('targets the Microsoft endpoint with response_mode=query and no Google-only params', () => {
    const u = new URL(buildMailAuthorizeUrl('graph', { ...BASE, send_enabled: false }));
    expect(`${u.origin}${u.pathname}`).toBe(MICROSOFT_AUTHORIZE_URL);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('response_mode')).toBe('query');
    expect(u.searchParams.get('access_type')).toBeNull();
    expect(u.searchParams.get('prompt')).toBeNull();
  });

  it('always includes Mail.Read + offline_access + User.Read; Mail.Send only when on', () => {
    const off = scopeSet(buildMailAuthorizeUrl('graph', { ...BASE, send_enabled: false }));
    expect(off.has('Mail.Read')).toBe(true);
    expect(off.has('offline_access')).toBe(true);
    expect(off.has('User.Read')).toBe(true);
    expect(off.has('Mail.Send')).toBe(false);

    const on = scopeSet(buildMailAuthorizeUrl('graph', { ...BASE, send_enabled: true }));
    expect(on.has('Mail.Send')).toBe(true);
  });
});

describe('buildCalendarAuthorizeUrl', () => {
  it('gcal → Google endpoint + calendar scope + offline/consent', () => {
    const u = new URL(buildCalendarAuthorizeUrl('gcal', BASE));
    expect(`${u.origin}${u.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    expect(scopeSet(u.toString())).toEqual(
      new Set(['https://www.googleapis.com/auth/calendar']),
    );
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
  });

  it('graph → Microsoft endpoint + Calendars.ReadWrite + offline_access + User.Read', () => {
    const u = new URL(buildCalendarAuthorizeUrl('graph', BASE));
    expect(`${u.origin}${u.pathname}`).toBe(MICROSOFT_AUTHORIZE_URL);
    expect(u.searchParams.get('response_mode')).toBe('query');
    expect(scopeSet(u.toString())).toEqual(
      new Set(['Calendars.ReadWrite', 'offline_access', 'User.Read']),
    );
  });
});

describe('scope-set helpers', () => {
  it('return fresh arrays + honor the send toggle', () => {
    expect(gmailScopes(false)).not.toContain('https://www.googleapis.com/auth/gmail.send');
    expect(gmailScopes(true)).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(graphMailScopes(false)).not.toContain('Mail.Send');
    expect(graphMailScopes(true)).toContain('Mail.Send');
    expect(gcalScopes()).toEqual(['https://www.googleapis.com/auth/calendar']);
    expect(graphCalendarScopes()).toContain('Calendars.ReadWrite');
    // Fresh array each call (no shared mutable state).
    expect(gmailScopes(true)).not.toBe(gmailScopes(true));
  });
});

describe('buildOpenerRelayRedirectUri', () => {
  it('same-origin (the cloud PWA) → callback path + relay marker, no opener_origin', () => {
    const uri = buildOpenerRelayRedirectUri(OAUTH_CLOUD_CALLBACK_ORIGIN);
    expect(uri).toBe('https://app.recued.com/oauth-callback?recued_relay=opener');
    expect(isOpenerRelayCallback(new URL(uri).searchParams)).toBe(true);
    // Same-origin → the cross-origin param is absent (byte-identical to pre-R26.2).
    expect(new URL(uri).searchParams.get(OAUTH_OPENER_ORIGIN_PARAM)).toBeNull();
  });

  it('OAUTH_CLOUD_CALLBACK_ORIGIN cannot drift from OAUTH_CLOUD_CALLBACK_URL', () => {
    // The builder hardcodes the origin; pin it to the canonical callback URL.
    expect(OAUTH_CLOUD_CALLBACK_ORIGIN + '/oauth-callback').toBe(OAUTH_CLOUD_CALLBACK_URL);
    expect(new URL(OAUTH_CLOUD_CALLBACK_URL).origin).toBe(OAUTH_CLOUD_CALLBACK_ORIGIN);
  });

  it('cross-origin self-served PWA → cloud host + percent-encoded opener_origin (R26.2)', () => {
    const uri = buildOpenerRelayRedirectUri('http://192.168.1.50');
    // Redirect host stays the cloud callback — providers reject the LAN-IP redirect.
    expect(uri.startsWith('https://app.recued.com/oauth-callback?')).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get(OAUTH_OPENER_RELAY_PARAM)).toBe(OAUTH_OPENER_RELAY_VALUE);
    // The PWA origin rides as opener_origin (URLSearchParams decodes on read).
    expect(params.get(OAUTH_OPENER_ORIGIN_PARAM)).toBe('http://192.168.1.50');
    // And is percent-encoded in the raw string (so the '&' can't split the URI).
    expect(uri).toContain('opener_origin=http%3A%2F%2F192.168.1.50');
  });

  it('round-trips: readOpenerRelayTarget recovers the PWA origin the builder embedded', () => {
    const uri = buildOpenerRelayRedirectUri('https://my.server.example');
    expect(readOpenerRelayTarget(new URL(uri).searchParams)).toBe('https://my.server.example');
  });

  it('byte-matches the redirect_uri embedded in the authorize URL (both origin modes)', () => {
    for (const origin of [OAUTH_CLOUD_CALLBACK_ORIGIN, 'http://192.168.1.50']) {
      const redirect_uri = buildOpenerRelayRedirectUri(origin);
      const authorize = buildMailAuthorizeUrl('gmail', {
        client_id: 'cid',
        redirect_uri,
        state: 's',
        send_enabled: false,
      });
      // The provider requires the exchange redirect_uri to byte-match the
      // authorize one — same string round-tripped, opener_origin included.
      expect(new URL(authorize).searchParams.get('redirect_uri')).toBe(redirect_uri);
    }
  });

  it('loopback PWA (R26.2 Option B) → same-origin self-serve, no opener_origin', () => {
    for (const origin of [
      'http://localhost:8787',
      'http://127.0.0.1:3000',
      'http://[::1]:8080',
      'https://localhost:8443',
    ]) {
      const uri = buildOpenerRelayRedirectUri(origin);
      // Served from the PWA's OWN origin via the webclient bundle path.
      expect(uri).toBe(
        `${origin}${WEBCLIENT_OAUTH_CALLBACK_PATH}?${OAUTH_OPENER_RELAY_PARAM}=${OAUTH_OPENER_RELAY_VALUE}`,
      );
      const params = new URL(uri).searchParams;
      expect(isOpenerRelayCallback(params)).toBe(true);
      // Same-origin → never carries opener_origin, never touches the cloud host.
      expect(params.get(OAUTH_OPENER_ORIGIN_PARAM)).toBeNull();
      expect(uri.startsWith(OAUTH_CLOUD_CALLBACK_ORIGIN)).toBe(false);
      expect(new URL(uri).origin).toBe(origin);
    }
  });

  it('loopback + noQueryMarker (Microsoft) → BARE URI, no query string', () => {
    // Microsoft Entra rejects query strings in registered redirect URIs, so the
    // graph flow drops the recued_relay marker; the loopback relay page gates on
    // the frelay_ state prefix instead.
    for (const origin of [
      'http://localhost:8787',
      'http://127.0.0.1:3000',
      'https://localhost:8443',
    ]) {
      const uri = buildOpenerRelayRedirectUri(origin, true);
      expect(uri).toBe(`${origin}${WEBCLIENT_OAUTH_CALLBACK_PATH}`);
      expect(uri.includes('?')).toBe(false);
      expect(new URL(uri).origin).toBe(origin);
    }
  });

  /** ⛔ It used to keep the marker, and an Entra app that takes personal
   *  accounts may not register a query string, so app.recued.com could not
   *  connect one. The callback page relays a `frelay_` state to its own
   *  origin without the marker, and on app.recued.com that is the opener. */
  it('cloud PWA + noQueryMarker (Microsoft) → the BARE cloud callback', () => {
    const uri = buildOpenerRelayRedirectUri(OAUTH_CLOUD_CALLBACK_ORIGIN, true);
    expect(uri).toBe(OAUTH_CLOUD_CALLBACK_URL);
    expect(uri.includes('?')).toBe(false);
    // Google still gets the marker from the same page.
    expect(buildOpenerRelayRedirectUri(OAUTH_CLOUD_CALLBACK_ORIGIN)).toBe(
      'https://app.recued.com/oauth-callback?recued_relay=opener',
    );
  });

  it('a LAN / own-https PWA + noQueryMarker still needs the marker and opener_origin', () => {
    // Its code must reach a cross-origin opener, which only a registered
    // opener_origin can name; an app that takes personal accounts cannot
    // register it, and the guide says so.
    for (const origin of ['http://192.168.1.50', 'https://my.server.example']) {
      const params = new URL(buildOpenerRelayRedirectUri(origin, true)).searchParams;
      expect(params.get(OAUTH_OPENER_RELAY_PARAM)).toBe(OAUTH_OPENER_RELAY_VALUE);
      expect(params.get(OAUTH_OPENER_ORIGIN_PARAM)).toBe(origin);
    }
  });

  it('LAN-IP / own-https self-served PWAs still bounce through the cloud (Option A)', () => {
    // Neither is loopback → cloud host + opener_origin (unchanged by Option B).
    for (const origin of ['http://192.168.1.50', 'https://my.server.example']) {
      const uri = buildOpenerRelayRedirectUri(origin);
      expect(uri.startsWith(`${OAUTH_CLOUD_CALLBACK_ORIGIN}/oauth-callback?`)).toBe(true);
      expect(new URL(uri).searchParams.get(OAUTH_OPENER_ORIGIN_PARAM)).toBe(origin);
    }
  });
});

describe('pickOAuthCallbackHost + isLoopbackOrigin (R26.2 Option B)', () => {
  it('self-serves loopback origins (own origin), clouds everything else', () => {
    for (const loop of [
      'http://localhost',
      'http://localhost:8787',
      'http://127.0.0.1:3000',
      'http://[::1]:8080',
      'https://localhost:8443',
    ]) {
      expect(isLoopbackOrigin(loop)).toBe(true);
      expect(pickOAuthCallbackHost(loop)).toBe(loop);
    }
    for (const other of [
      OAUTH_CLOUD_CALLBACK_ORIGIN, // the cloud PWA is NOT self-serve
      'http://192.168.1.50',
      'https://my.server.example',
      'http://127.0.0.2:3000', // only 127.0.0.1 is loopback, not the /8
    ]) {
      expect(isLoopbackOrigin(other)).toBe(false);
      expect(pickOAuthCallbackHost(other)).toBe(OAUTH_CLOUD_CALLBACK_ORIGIN);
    }
  });

  it('rejects non-http(s), non-canonical, and malformed origins (→ cloud, fail-safe)', () => {
    for (const bad of [
      'ftp://localhost',
      'http://localhost/path', // not a bare origin
      'http://localhost@evil.com', // host-confusion
      'not-a-url',
      '',
    ]) {
      expect(isLoopbackOrigin(bad)).toBe(false);
      expect(pickOAuthCallbackHost(bad)).toBe(OAUTH_CLOUD_CALLBACK_ORIGIN);
    }
  });

  it('WEBCLIENT_OAUTH_CALLBACK_PATH lives under the webclient bundle prefix', () => {
    // The self-serve page must be a webclient bundle asset, so the existing
    // LAN webclient handler serves it.
    expect(WEBCLIENT_OAUTH_CALLBACK_PATH.startsWith(`${WEBCLIENT_PATH_PREFIX}/`)).toBe(true);
    expect(WEBCLIENT_OAUTH_CALLBACK_PATH.endsWith('.html')).toBe(true);
  });
});

describe('readOpenerRelayTarget', () => {
  it('returns the origin only when opener_origin is already a canonical http(s) origin', () => {
    expect(
      readOpenerRelayTarget(new URLSearchParams('opener_origin=https://my.server.example')),
    ).toBe('https://my.server.example');
    // A port is part of the canonical origin and is preserved.
    expect(
      readOpenerRelayTarget(new URLSearchParams('opener_origin=http://192.168.1.50:8080')),
    ).toBe('http://192.168.1.50:8080');
  });

  it('returns null (→ callback relays same-origin) when absent, empty, malformed, non-http(s), or non-canonical', () => {
    expect(readOpenerRelayTarget(new URLSearchParams('code=x&state=y'))).toBeNull();
    expect(readOpenerRelayTarget(new URLSearchParams('opener_origin='))).toBeNull();
    expect(readOpenerRelayTarget(new URLSearchParams('opener_origin=not-a-url'))).toBeNull();
    // Protocol allowlist blocks dangerous schemes that DO parse as URLs.
    expect(readOpenerRelayTarget(new URLSearchParams('opener_origin=javascript:alert(1)'))).toBeNull();
    expect(readOpenerRelayTarget(new URLSearchParams('opener_origin=ftp://example.com'))).toBeNull();
    // Canonical-origin guard rejects host-confusion + non-bare-origin forms
    // (defense-in-depth; exact-redirect registration already blocks injection).
    expect(
      readOpenerRelayTarget(new URLSearchParams('opener_origin=https://app.recued.com@evil.com')),
    ).toBeNull();
    expect(readOpenerRelayTarget(new URLSearchParams('opener_origin=https:evil'))).toBeNull();
    expect(
      readOpenerRelayTarget(new URLSearchParams('opener_origin=http://192.168.1.50:8080/x')),
    ).toBeNull(); // has a path → not a bare origin
  });
});

describe('isOpenerRelayCallback', () => {
  it('is true only when the marker query param matches exactly', () => {
    expect(isOpenerRelayCallback(new URLSearchParams('recued_relay=opener'))).toBe(true);
    expect(
      isOpenerRelayCallback(new URLSearchParams('recued_relay=opener&code=x&state=y')),
    ).toBe(true);
    expect(isOpenerRelayCallback(new URLSearchParams('code=x&state=y'))).toBe(false);
    expect(isOpenerRelayCallback(new URLSearchParams('recued_relay=server'))).toBe(false);
  });
});

describe('oauthCallbackUrlForPwa — the URL the form tells you to REGISTER', () => {
  it('a LOOPBACK PWA registers its OWN origin, not the cloud', () => {
    // The bug this closes: the form printed the cloud URL under "Register this
    // unchanged", while `pickOAuthCallbackHost` sent the flow to the PWA's own
    // origin — so the provider answered `redirect_uri_mismatch`.
    for (const origin of ['http://127.0.0.1:7841', 'http://localhost:7841', 'http://[::1]:7841']) {
      expect(oauthCallbackUrlForPwa(origin), origin)
        .toBe(`${origin}${WEBCLIENT_OAUTH_CALLBACK_PATH}`);
    }
  });

  it('a non-loopback PWA still registers the cloud URL', () => {
    for (const origin of ['https://app.recued.com', 'http://192.168.1.10:7841', 'https://recued.example.com']) {
      expect(oauthCallbackUrlForPwa(origin), origin).toBe(OAUTH_CLOUD_CALLBACK_URL);
    }
  });

  it('🔑 never disagrees with the host the popup driver actually uses', () => {
    // The whole point: one rule, not two copies. A printed URL that drifts from
    // `pickOAuthCallbackHost` is the defect, so assert they agree by
    // construction rather than by matching literals.
    for (const origin of [
      'http://127.0.0.1:7841',
      'http://localhost:3000',
      'https://app.recued.com',
      'http://192.168.1.10:7841',
    ]) {
      expect(oauthCallbackUrlForPwa(origin).startsWith(pickOAuthCallbackHost(origin)), origin)
        .toBe(true);
    }
  });
});

describe('alternateOAuthCallbackUrl — the URL the OTHER address needs', () => {
  it('names the cloud URL when you are on loopback', () => {
    // Verified against a live server: the local callback is
    // `/webclient/oauth-callback.html` and the cloud one is `/oauth-callback`
    // — different path AND extension, so neither is guessable from the other.
    // An owner who registers one and later opens the other address gets
    // `redirect_uri_mismatch` with nothing on screen to explain it.
    expect(alternateOAuthCallbackUrl('http://127.0.0.1:7841')).toBe(OAUTH_CLOUD_CALLBACK_URL);
    expect(alternateOAuthCallbackUrl('http://localhost:3000')).toBe(OAUTH_CLOUD_CALLBACK_URL);
  });

  it('names nothing when the cloud URL is ALREADY the one shown', () => {
    // On any non-loopback origin `oauthCallbackUrlForPwa` already resolves to
    // the cloud URL, so a "register this too" note would point at the value
    // directly above it.
    for (const origin of ['https://app.recued.com', 'https://recued.example.com']) {
      expect(alternateOAuthCallbackUrl(origin), origin).toBeNull();
      expect(oauthCallbackUrlForPwa(origin), origin).toBe(OAUTH_CLOUD_CALLBACK_URL);
    }
  });

  it('🔑 the two URLs are never equal when both are shown', () => {
    // The note only earns its space if it says something new.
    const origin = 'http://127.0.0.1:7841';
    expect(alternateOAuthCallbackUrl(origin)).not.toBe(oauthCallbackUrlForPwa(origin));
  });
});
