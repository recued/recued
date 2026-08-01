/** Boot-scoped foundational OAuth continuity: route presentations may detach,
 * but the one consent transaction, exact callback, and one-shot result remain. */

import { describe, expect, it, vi } from 'vitest';
import {
  OPENER_RELAY_MESSAGE_KIND,
  OAUTH_OPENER_RELAY_STATE_PREFIX,
  buildOpenerRelayRedirectUri,
} from '@recued/contracts';
import {
  createFoundationalOAuthContinuity,
  type FoundationalOAuthStartRequest,
  type FoundationalOAuthWorkLease,
} from '../connections/foundational-oauth-continuity.js';
import type { FoundationalOAuthEnv } from '../connections/foundational-oauth-popup.js';

const ORIGIN = 'https://app.recued.com';
const STATE = `${OAUTH_OPENER_RELAY_STATE_PREFIX}CONTINUITY-STATE`;
const NOW = 1_800_000_000_000;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    data,
  };
};

const makeHarness = () => {
  let onMessage: ((event: { origin: string; data: unknown }) => void) | null = null;
  const env: FoundationalOAuthEnv = {
    origin: ORIGIN,
    randomState: () => 'CONTINUITY-STATE',
    onMessage: (listener) => {
      onMessage = listener;
      return () => { onMessage = null; };
    },
    setTimeout: () => () => undefined,
    setInterval: () => () => undefined,
  };
  const popup: {
    closed: boolean;
    location: { href: string };
    close: () => void;
  } = {
    closed: false,
    location: { href: '' },
    close: vi.fn(() => { popup.closed = true; }),
  };
  return {
    env,
    popup,
    dispatchCode: (code: string) => onMessage?.({
      origin: ORIGIN,
      data: { kind: OPENER_RELAY_MESSAGE_KIND, state: STATE, code },
    }),
    hasRelayListener: () => onMessage !== null,
  };
};

const makeWorkProjection = () => {
  const update = vi.fn();
  const release = Object.assign(vi.fn(), { update }) as FoundationalOAuthWorkLease;
  const beginWork = vi.fn(() => release);
  return { beginWork, release, update };
};

const makeRequest = (
  harness: ReturnType<typeof makeHarness>,
  enroll: FoundationalOAuthStartRequest['enroll'],
  over: Partial<FoundationalOAuthStartRequest> = {},
): FoundationalOAuthStartRequest => ({
  lane: 'mail',
  providerId: 'gmail',
  providerLabel: 'Gmail',
  slug: 'work',
  issuer: 'google',
  returnHref: '#connections/mail',
  accountValues: { name: 'work' },
  clientId: 'GOOGLE-CLIENT-ID',
  popup: harness.popup,
  env: harness.env,
  resolveClientId: async () => 'GOOGLE-CLIENT-ID',
  buildAuthorizeUrl: ({ client_id, redirect_uri, state }) => {
    const url = new URL('https://accounts.google.test/authorize');
    url.searchParams.set('client_id', client_id);
    url.searchParams.set('redirect_uri', redirect_uri);
    url.searchParams.set('state', state);
    return url.toString();
  },
  enroll,
  missingClientIdMessage: 'Missing client id.',
  popupFailureMessage: (reason, detail) => `${reason}${detail ? `: ${detail}` : ''}`,
  errorMessage: (error) => error instanceof Error ? error.message : String(error),
  ...over,
});

describe('createFoundationalOAuthContinuity', () => {
  it('keeps one safe transaction across presentation gaps and exposes one exact result', async () => {
    const harness = makeHarness();
    const exchange = deferred<{ note: string }>();
    const enroll = vi.fn(() => exchange.promise);
    const work = makeWorkProjection();
    const continuity = createFoundationalOAuthContinuity({
      beginWork: work.beginWork,
    });
    const saveAppConfig = vi.fn(async (_secret: string) => undefined);

    const started = continuity.start(makeRequest(harness, enroll, {
      saveAppConfig: {
        issuer: 'google',
        clientId: 'SAVED-CLIENT-ID',
        // The closure may briefly capture a write-only secret while the save
        // runs, but neither it nor the secret can enter a public snapshot.
        run: async () => {
          const clientSecret = 'DO-NOT-RETAIN-THIS-SECRET';
          await saveAppConfig(clientSecret);
        },
      },
      resolveClientId: async () => 'SAVED-CLIENT-ID',
    }));
    expect(started).toEqual({ ok: true, flowId: 'foundational-oauth-1' });
    expect(work.beginWork).toHaveBeenCalledWith({
      id: 'connections:oauth:foundational-oauth-1',
      label: 'Waiting for Gmail sign-in',
      returnHref: '#connections/mail',
      returnLabel: 'Finish connecting',
    });

    await tick();
    const pending = continuity.snapshot();
    expect(pending).toMatchObject({
      status: 'pending',
      stage: 'waiting_for_consent',
      returnHref: '#connections/mail',
      accountValues: { name: 'work' },
      savedAppConfig: { issuer: 'google', clientId: 'SAVED-CLIENT-ID' },
    });
    expect(JSON.stringify(pending)).not.toContain('DO-NOT-RETAIN-THIS-SECRET');
    expect(harness.hasRelayListener()).toBe(true);

    const authorizeUrl = new URL(harness.popup.location.href);
    const redirectUri = buildOpenerRelayRedirectUri(ORIGIN);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(authorizeUrl.searchParams.get('state')).toBe(STATE);

    harness.dispatchCode('ONE-CODE');
    await tick();
    expect(enroll).toHaveBeenCalledTimes(1);
    expect(enroll).toHaveBeenCalledWith({
      code: 'ONE-CODE',
      redirect_uri: redirectUri,
    });
    expect(continuity.snapshot()).toMatchObject({
      status: 'pending',
      stage: 'finishing',
    });
    expect(work.update).toHaveBeenCalledWith({
      label: 'Finishing Gmail connection',
    });

    exchange.resolve({ note: 'Calendar can be added later.' });
    await tick();
    const terminal = continuity.snapshot();
    expect(terminal).toMatchObject({
      status: 'succeeded',
      slug: 'work',
      note: 'Calendar can be added later.',
    });
    expect(work.update).toHaveBeenLastCalledWith({
      label: 'Gmail connected — view next steps',
      returnLabel: 'View connection',
      phase: 'result_ready',
    });

    expect(continuity.takeTerminal('foundational-oauth-1')).toMatchObject({
      status: 'succeeded',
      slug: 'work',
    });
    expect(continuity.takeTerminal('foundational-oauth-1')).toBeNull();
    expect(work.release).toHaveBeenCalledTimes(1);
    expect(continuity.snapshot()).toEqual({ status: 'idle' });
    continuity.dispose();
  });

  it('cancels before exchange, closes consent, and never enrolls', async () => {
    const harness = makeHarness();
    const enroll = vi.fn(async () => undefined);
    const continuity = createFoundationalOAuthContinuity();
    const started = continuity.start(makeRequest(harness, enroll));
    if (!started.ok) throw new Error('flow did not start');
    await tick();

    expect(continuity.cancel(started.flowId)).toBe(true);
    await tick();

    expect(harness.popup.close).toHaveBeenCalledTimes(1);
    expect(harness.hasRelayListener()).toBe(false);
    expect(enroll).not.toHaveBeenCalled();
    expect(continuity.snapshot()).toMatchObject({
      status: 'failed',
      error: 'Sign-in cancelled. No account was connected.',
    });
    continuity.dispose();
  });

  it('does not claim cancellation once the server exchange has begun', async () => {
    const harness = makeHarness();
    const exchange = deferred<void>();
    const enroll = vi.fn(() => exchange.promise);
    const continuity = createFoundationalOAuthContinuity();
    const started = continuity.start(makeRequest(harness, enroll));
    if (!started.ok) throw new Error('flow did not start');
    await tick();
    harness.dispatchCode('SPENT-CODE');
    await tick();

    expect(continuity.snapshot()).toMatchObject({
      status: 'pending',
      stage: 'finishing',
    });
    expect(continuity.cancel(started.flowId)).toBe(false);
    expect(enroll).toHaveBeenCalledTimes(1);

    exchange.resolve();
    await tick();
    expect(continuity.snapshot()).toMatchObject({ status: 'succeeded' });
    continuity.dispose();
  });

  it('restores a pre-exchange reload as one exact, secret-free restart', async () => {
    const storage = memoryStorage();
    const harness = makeHarness();
    const first = createFoundationalOAuthContinuity({
      storage,
      scopeId: 'profile-office',
      now: () => NOW,
    });
    const started = first.start(makeRequest(harness, vi.fn(async () => undefined), {
      accountValues: {
        name: 'work',
        send_enabled: 'true',
        future_secret: 'DO-NOT-STORE',
      },
    }));
    expect(started.ok).toBe(true);
    await tick();

    const raw = [...storage.data.values()][0] ?? '';
    expect(raw).toContain('before_exchange');
    expect(raw).toContain('send_enabled');
    expect(raw).not.toContain('future_secret');
    expect(raw).not.toContain('DO-NOT-STORE');
    expect(JSON.stringify(first.snapshot())).not.toContain('future_secret');
    expect(JSON.stringify(first.snapshot())).not.toContain('DO-NOT-STORE');

    const work = makeWorkProjection();
    const restored = createFoundationalOAuthContinuity({
      storage,
      scopeId: 'profile-office',
      now: () => NOW + 1,
      beginWork: work.beginWork,
    });
    const recovery = restored.snapshot();
    if (recovery.status === 'idle') throw new Error('reload was not recovered');
    expect(recovery).toMatchObject({
      status: 'failed',
      lane: 'mail',
      providerId: 'gmail',
      slug: 'work',
      returnHref: '#connections/mail',
      accountValues: { name: 'work', send_enabled: 'true' },
      reloadInterruption: { phase: 'before_exchange' },
    });
    expect(work.beginWork).toHaveBeenCalledWith(expect.objectContaining({
      returnHref: '#connections/mail',
      returnLabel: 'Restart sign-in',
    }));
    // A boot that stops before the exact lane consumes the result does not lose
    // it. The next boot may restore it again, then consumption retires it.
    restored.dispose();
    const resumed = createFoundationalOAuthContinuity({
      storage,
      scopeId: 'profile-office',
      now: () => NOW + 2,
    });
    const resumedRecovery = resumed.snapshot();
    if (resumedRecovery.status === 'idle') throw new Error('reload did not survive boot stop');
    expect(resumedRecovery).toMatchObject({
      status: 'failed',
      reloadInterruption: { phase: 'before_exchange' },
    });
    expect(resumed.takeTerminal(resumedRecovery.id)).not.toBeNull();
    expect(resumed.snapshot()).toEqual({ status: 'idle' });
    expect(createFoundationalOAuthContinuity({
      storage,
      scopeId: 'profile-office',
      now: () => NOW + 3,
    }).snapshot()).toEqual({ status: 'idle' });
    first.dispose();
    resumed.dispose();
  });

  it('marks exchange before dispatch and restores an outcome that requires verification', async () => {
    const storage = memoryStorage();
    const harness = makeHarness();
    const exchange = deferred<void>();
    const enroll = vi.fn(() => exchange.promise);
    const first = createFoundationalOAuthContinuity({
      storage,
      scopeId: 'profile-office',
      now: () => NOW,
    });
    first.start(makeRequest(harness, enroll));
    await tick();
    harness.dispatchCode('NEVER-PERSIST-THIS-CODE');
    await tick();

    expect(enroll).toHaveBeenCalledTimes(1);
    const raw = [...storage.data.values()][0] ?? '';
    expect(raw).toContain('during_exchange');
    expect(raw).not.toContain('NEVER-PERSIST-THIS-CODE');

    const restored = createFoundationalOAuthContinuity({
      storage,
      scopeId: 'profile-office',
      now: () => NOW + 1,
    });
    const recovery = restored.snapshot();
    expect(recovery).toMatchObject({
      status: 'failed',
      slug: 'work',
      reloadInterruption: { phase: 'during_exchange' },
    });
    if (recovery.status !== 'failed') throw new Error('reload was not recovered');
    expect(recovery.error).toContain(
      'Check the server before signing in again',
    );

    exchange.resolve();
    await tick();
    first.dispose();
    restored.dispose();
  });

  it('never dispatches enrollment when an armed marker cannot advance to exchange', async () => {
    const data = new Map<string, string>();
    let writes = 0;
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes > 1) throw new Error('storage became unavailable');
        data.set(key, value);
      },
      removeItem: (key: string) => { data.delete(key); },
    };
    const harness = makeHarness();
    const enroll = vi.fn(async () => undefined);
    const continuity = createFoundationalOAuthContinuity({
      storage,
      scopeId: 'profile-office',
      now: () => NOW,
    });
    continuity.start(makeRequest(harness, enroll));
    await tick();
    harness.dispatchCode('UNSPENT-CODE');
    await tick();

    expect(enroll).not.toHaveBeenCalled();
    expect(continuity.snapshot()).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Nothing was sent to the server'),
    });
    continuity.dispose();
  });
});
