import { describe, expect, it, vi } from 'vitest';
import {
  createWebhookClockHealthAuthority,
  resolveWebhookClockAuthorityUrl,
} from '../webhook-clock-health.js';

const REMOTE_SECOND = Date.UTC(2026, 6, 11, 12, 0, 0);
const NONCE = '0123456789abcdef0123456789abcdef';
const authorityHeaders = (
  nonce = NONCE,
  date = new Date(REMOTE_SECOND).toUTCString(),
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  Date: date,
  'X-Recued-Clock-Nonce': nonce,
  ...extra,
});

describe('D-201 Slice 5B2B2B2B trusted clock health', () => {
  it('accepts only a boot-pinned credential-free HTTPS authority URL', () => {
    expect(resolveWebhookClockAuthorityUrl(undefined)).toBeNull();
    expect(resolveWebhookClockAuthorityUrl('')).toBeNull();
    expect(resolveWebhookClockAuthorityUrl('http://clock.example/probe')).toBeNull();
    expect(resolveWebhookClockAuthorityUrl(
      'https://owner:secret@clock.example/probe',
    )).toBeNull();
    expect(resolveWebhookClockAuthorityUrl(
      'https://clock.example/probe?cache=1',
    )).toBeNull();
    expect(resolveWebhookClockAuthorityUrl(
      'https://clock.example/probe?',
    )).toBeNull();
    expect(resolveWebhookClockAuthorityUrl(
      'https://clock.example/probe#fragment',
    )).toBeNull();
    expect(resolveWebhookClockAuthorityUrl(
      '  https://clock.example/probe  ',
    )).toBe('https://clock.example/probe');
  });

  it('derives bounded trusted time from a strict fresh HTTPS Date response', async () => {
    let monotonic = 1_000;
    let wall = REMOTE_SECOND + 200;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe('https://clock.example/probe');
      expect(url.searchParams.get('_recued_clock_probe')).toBe(NONCE);
      expect(init).toMatchObject({
        method: 'HEAD',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('x-recued-clock-nonce')).toBe(NONCE);
      expect(headers.get('cache-control')).toBe('no-cache, no-store');
      expect(headers.get('pragma')).toBe('no-cache');
      monotonic += 100;
      wall += 100;
      return new Response(null, {
        status: 204,
        headers: authorityHeaders(),
      });
    });
    const authority = createWebhookClockHealthAuthority({
      authorityUrl: 'https://clock.example/probe',
      fetchImpl: fetchImpl as typeof fetch,
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      newProbeNonce: () => NONCE,
    });

    await expect(authority.check()).resolves.toEqual({
      healthy: true,
      trusted_now_ms: REMOTE_SECOND + 550,
      maximum_error_ms: 801,
      checked_at: REMOTE_SECOND + 550,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    monotonic += 10_000;
    wall += 10_000;
    await expect(authority.check()).resolves.toEqual({
      healthy: true,
      trusted_now_ms: REMOTE_SECOND + 10_550,
      maximum_error_ms: 901,
      checked_at: REMOTE_SECOND + 550,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('expires evidence against monotonic time and obtains a new cache-busted probe', async () => {
    let monotonic = 10_000;
    let wall = REMOTE_SECOND + 100;
    let remoteSecond = REMOTE_SECOND;
    const nonces = [NONCE, 'fedcba9876543210fedcba9876543210'];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      monotonic += 100;
      wall += 100;
      const nonce = new URL(String(input)).searchParams.get('_recued_clock_probe')!;
      return new Response(null, {
        status: 200,
        headers: authorityHeaders(
          nonce,
          new Date(remoteSecond).toUTCString(),
        ),
      });
    });
    const authority = createWebhookClockHealthAuthority({
      authorityUrl: 'https://clock.example/probe',
      fetchImpl: fetchImpl as typeof fetch,
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      newProbeNonce: () => nonces.shift()!,
      evidenceTtlMs: 1_000,
    });

    expect((await authority.check()).healthy).toBe(true);
    monotonic += 1_001;
    wall += 1_001;
    remoteSecond += 1_000;
    expect((await authority.check()).healthy).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent probes into one outbound authority request', async () => {
    let monotonic = 1_000;
    let wall = REMOTE_SECOND + 200;
    let resolveResponse!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchImpl = vi.fn(() => pending);
    const authority = createWebhookClockHealthAuthority({
      authorityUrl: 'https://clock.example/probe',
      fetchImpl: fetchImpl as typeof fetch,
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      newProbeNonce: () => NONCE,
    });

    const first = authority.check();
    const second = authority.check();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    monotonic += 100;
    wall += 100;
    resolveResponse(new Response(null, {
      status: 204,
      headers: authorityHeaders(),
    }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ healthy: true }),
      expect.objectContaining({ healthy: true }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('hard-times out even when an injected transport ignores abort', async () => {
    let monotonic = 1_000;
    let signal: AbortSignal | undefined;
    let resolveResponse!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchImpl = vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      signal = init?.signal ?? undefined;
      return pending;
    });
    const authority = createWebhookClockHealthAuthority({
      authorityUrl: 'https://clock.example/probe',
      fetchImpl: fetchImpl as typeof fetch,
      wallNow: () => REMOTE_SECOND,
      monotonicNow: () => monotonic,
      newProbeNonce: () => NONCE,
      probeTimeoutMs: 5,
      failureRetryMs: 5,
    });

    await expect(authority.check()).resolves.toEqual({
      healthy: false,
      reason: 'probe_unavailable',
    });
    expect(signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    monotonic += 6;
    await expect(authority.check()).resolves.toEqual({
      healthy: false,
      reason: 'probe_unavailable',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const cancel = vi.fn();
    resolveResponse(new Response(new ReadableStream({ cancel }), {
      status: 200,
      headers: authorityHeaders(),
    }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it('fails closed on missing/malformed Date, redirects, excessive RTT, or clock error', async () => {
    const cases: Array<{
      response: () => Response;
      advance: number;
      wall: number;
      reason: string;
    }> = [
      {
        response: () => new Response(null, {
          status: 204,
          headers: { 'X-Recued-Clock-Nonce': NONCE },
        }),
        advance: 100,
        wall: REMOTE_SECOND,
        reason: 'invalid_response',
      },
      {
        response: () => new Response(null, {
          status: 204,
          headers: authorityHeaders(NONCE, '2026-07-11T12:00:00Z'),
        }),
        advance: 100,
        wall: REMOTE_SECOND,
        reason: 'invalid_response',
      },
      {
        response: () => new Response(null, {
          status: 204,
          headers: authorityHeaders('fedcba9876543210fedcba9876543210'),
        }),
        advance: 100,
        wall: REMOTE_SECOND,
        reason: 'invalid_response',
      },
      {
        response: () => new Response(null, {
          status: 302,
          headers: {
            ...authorityHeaders(),
            Location: 'https://other.example/',
          },
        }),
        advance: 100,
        wall: REMOTE_SECOND,
        reason: 'invalid_response',
      },
      {
        response: () => new Response(null, {
          status: 503,
          headers: authorityHeaders(),
        }),
        advance: 100,
        wall: REMOTE_SECOND,
        reason: 'invalid_response',
      },
      {
        response: () => new Response(null, {
          status: 204,
          headers: authorityHeaders(NONCE, undefined, { Age: '1' }),
        }),
        advance: 100,
        wall: REMOTE_SECOND,
        reason: 'invalid_response',
      },
      {
        response: () => new Response(null, {
          status: 204,
          headers: authorityHeaders(),
        }),
        advance: 2_001,
        wall: REMOTE_SECOND + 2_001,
        reason: 'round_trip_exceeded',
      },
      {
        response: () => new Response(null, {
          status: 204,
          headers: authorityHeaders(),
        }),
        advance: 100,
        wall: REMOTE_SECOND + 30_000,
        reason: 'clock_error_exceeded',
      },
    ];

    for (const testCase of cases) {
      let monotonic = 1_000;
      let wall = testCase.wall;
      const authority = createWebhookClockHealthAuthority({
        authorityUrl: 'https://clock.example/probe',
        fetchImpl: (async () => {
          monotonic += testCase.advance;
          return testCase.response();
        }) as typeof fetch,
        wallNow: () => wall,
        monotonicNow: () => monotonic,
        newProbeNonce: () => NONCE,
      });
      await expect(authority.check()).resolves.toEqual({
        healthy: false,
        reason: testCase.reason,
      });
      wall += 1;
    }
  });

  it('invalidates cached evidence after a local wall-clock step and rate-bounds failed probes', async () => {
    let monotonic = 1_000;
    let wall = REMOTE_SECOND + 200;
    const fetchImpl = vi.fn(async () => {
      monotonic += 100;
      wall += 100;
      return new Response(null, {
        status: 204,
        headers: authorityHeaders(),
      });
    });
    const authority = createWebhookClockHealthAuthority({
      authorityUrl: 'https://clock.example/probe',
      fetchImpl: fetchImpl as typeof fetch,
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      newProbeNonce: () => NONCE,
      failureRetryMs: 1_000,
    });

    expect((await authority.check()).healthy).toBe(true);
    wall += 30_000;
    await expect(authority.check()).resolves.toEqual({
      healthy: false,
      reason: 'clock_error_exceeded',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(authority.check()).resolves.toEqual({
      healthy: false,
      reason: 'clock_error_exceeded',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
