/** D-174 Slice 2b — foundational-lane OAuth popup driver. */

import { describe, it, expect, vi } from 'vitest';
import {
  OPENER_RELAY_MESSAGE_KIND,
  OAUTH_OPENER_RELAY_STATE_PREFIX,
} from '@recued/contracts';
import {
  runOAuthPopup,
  type FoundationalOAuthEnv,
} from '../connections/foundational-oauth-popup.js';

const ORIGIN = 'https://app.recued.com';
// The driver prepends the family prefix to env.randomState() ('STATE-NONCE').
const STATE = OAUTH_OPENER_RELAY_STATE_PREFIX + 'STATE-NONCE';

const makeEnv = (origin = ORIGIN) => {
  let onMsg: ((ev: { origin: string; data: unknown }) => void) | null = null;
  let timeoutCb: (() => void) | null = null;
  let intervalCb: (() => void) | null = null;
  const env: FoundationalOAuthEnv = {
    origin,
    randomState: () => 'STATE-NONCE',
    onMessage: (h) => {
      onMsg = h;
      return () => { onMsg = null; };
    },
    setTimeout: (cb) => {
      timeoutCb = cb;
      return () => { timeoutCb = null; };
    },
    setInterval: (cb) => {
      intervalCb = cb;
      return () => { intervalCb = null; };
    },
  };
  return {
    env,
    dispatch: (o: string, data: unknown) => onMsg?.({ origin: o, data }),
    fireTimeout: () => timeoutCb?.(),
    firePoll: () => intervalCb?.(),
    hasListener: () => onMsg !== null,
  };
};

const makePopup = () => {
  const popup = {
    closed: false,
    location: { href: '' },
    close: vi.fn(() => { popup.closed = true; }),
  };
  return popup;
};

/** Flush microtasks so the driver navigates the popup + registers its
 *  message listener before the test dispatches. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('runOAuthPopup', () => {
  it('navigates the popup to the built URL (with the minted state) and resolves with the code', async () => {
    const { env, dispatch, hasListener } = makeEnv();
    const popup = makePopup();
    const promise = runOAuthPopup(env, {
      popup,
      expectedSenderOrigin: ORIGIN,
      buildAuthorizeUrl: (state) =>
        `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    });
    await tick();
    expect(popup.location.href).toBe(
      `https://accounts.google.com/o/oauth2/v2/auth?state=${STATE}`,
    );
    expect(hasListener()).toBe(true);
    dispatch(ORIGIN, {
      kind: OPENER_RELAY_MESSAGE_KIND,
      state: STATE,
      code: 'CODE-123',
    });
    await expect(promise).resolves.toEqual({
      ok: true,
      code: 'CODE-123',
      state: STATE,
    });
    expect(popup.close).toHaveBeenCalled();
  });

  it('returns popup_blocked when the popup is null', async () => {
    const { env } = makeEnv();
    await expect(
      runOAuthPopup(env, { popup: null, expectedSenderOrigin: ORIGIN, buildAuthorizeUrl: () => 'x' }),
    ).resolves.toEqual({ ok: false, reason: 'popup_blocked' });
  });

  it('relays a provider error as denied', async () => {
    const { env, dispatch } = makeEnv();
    const popup = makePopup();
    const promise = runOAuthPopup(env, { popup, expectedSenderOrigin: ORIGIN, buildAuthorizeUrl: () => 'u' });
    await tick();
    dispatch(ORIGIN, {
      kind: OPENER_RELAY_MESSAGE_KIND,
      state: STATE,
      error: 'access_denied',
    });
    await expect(promise).resolves.toEqual({
      ok: false,
      reason: 'denied',
      detail: 'access_denied',
    });
  });

  it('ignores a message from a different origin (CSRF), then times out', async () => {
    const { env, dispatch, fireTimeout } = makeEnv();
    const popup = makePopup();
    const promise = runOAuthPopup(env, { popup, expectedSenderOrigin: ORIGIN, buildAuthorizeUrl: () => 'u' });
    await tick();
    dispatch('https://evil.example', {
      kind: OPENER_RELAY_MESSAGE_KIND,
      state: STATE,
      code: 'STOLEN',
    });
    fireTimeout();
    await expect(promise).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('ignores a message with a mismatched state (CSRF), then times out', async () => {
    const { env, dispatch, fireTimeout } = makeEnv();
    const popup = makePopup();
    const promise = runOAuthPopup(env, { popup, expectedSenderOrigin: ORIGIN, buildAuthorizeUrl: () => 'u' });
    await tick();
    dispatch(ORIGIN, {
      kind: OPENER_RELAY_MESSAGE_KIND,
      state: 'WRONG-STATE',
      code: 'CODE',
    });
    fireTimeout();
    await expect(promise).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('ignores a message with the wrong kind', async () => {
    const { env, dispatch, fireTimeout } = makeEnv();
    const popup = makePopup();
    const promise = runOAuthPopup(env, { popup, expectedSenderOrigin: ORIGIN, buildAuthorizeUrl: () => 'u' });
    await tick();
    dispatch(ORIGIN, { kind: 'something-else', state: 'STATE-NONCE', code: 'CODE' });
    fireTimeout();
    await expect(promise).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('resolves closed when the popup is shut by the user', async () => {
    const { env, firePoll } = makeEnv();
    const popup = makePopup();
    const promise = runOAuthPopup(env, { popup, expectedSenderOrigin: ORIGIN, buildAuthorizeUrl: () => 'u' });
    await tick();
    popup.closed = true;
    firePoll();
    await expect(promise).resolves.toEqual({ ok: false, reason: 'closed' });
  });

  it('cancels explicitly, closes the popup, and detaches the relay listener', async () => {
    const { env, hasListener } = makeEnv();
    const popup = makePopup();
    const abort = new AbortController();
    const promise = runOAuthPopup(env, {
      popup,
      expectedSenderOrigin: ORIGIN,
      buildAuthorizeUrl: () => 'u',
      signal: abort.signal,
    });
    await tick();
    expect(hasListener()).toBe(true);

    abort.abort();

    await expect(promise).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(hasListener()).toBe(false);
  });

  it('returns error (and closes the popup) when the URL build throws', async () => {
    const { env } = makeEnv();
    const popup = makePopup();
    const result = await runOAuthPopup(env, {
      popup,
      expectedSenderOrigin: ORIGIN,
      buildAuthorizeUrl: () => {
        throw new Error('no client_id configured');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'error', detail: 'no client_id configured' });
    expect(popup.close).toHaveBeenCalled();
  });

  // ── R26.2 — cross-origin opener: trust the CALLBACK origin, not env.origin ──
  it('accepts the code from the callback origin even when env.origin (the PWA) differs', async () => {
    // Self-served PWA at 192.168.1.50; the cloud callback (app.recued.com)
    // relays the code, so ev.origin is the callback host, NOT the PWA.
    const { env, dispatch } = makeEnv('http://192.168.1.50');
    const popup = makePopup();
    const promise = runOAuthPopup(env, {
      popup,
      expectedSenderOrigin: ORIGIN, // the cloud callback host
      buildAuthorizeUrl: () => 'u',
    });
    await tick();
    dispatch(ORIGIN, { kind: OPENER_RELAY_MESSAGE_KIND, state: STATE, code: 'X-CODE' });
    await expect(promise).resolves.toEqual({ ok: true, code: 'X-CODE', state: STATE });
  });

  it('REJECTS a message forged from the PWA’s own origin (only the callback is trusted)', async () => {
    const { env, dispatch, fireTimeout } = makeEnv('http://192.168.1.50');
    const popup = makePopup();
    const promise = runOAuthPopup(env, {
      popup,
      expectedSenderOrigin: ORIGIN,
      buildAuthorizeUrl: () => 'u',
    });
    await tick();
    // A code posted from the PWA's OWN origin must NOT be accepted — the only
    // trusted sender is the callback host.
    dispatch('http://192.168.1.50', { kind: OPENER_RELAY_MESSAGE_KIND, state: STATE, code: 'STOLEN' });
    fireTimeout();
    await expect(promise).resolves.toEqual({ ok: false, reason: 'timeout' });
  });
});
