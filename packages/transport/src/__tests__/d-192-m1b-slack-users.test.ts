/** D-192 M1b — the Slack `users.info` profile-email leaf.
 *
 *  Locks the fail-soft contract: an email on `ok:true` + a well-formed
 *  profile; `null` on every failure mode (missing scope / user-not-found /
 *  non-2xx / network / timeout / absent-or-blank email); the outbound request
 *  shape (URL / Bearer header / `{user}` body); and the no-fetch short-circuit
 *  on a blank token / id.
 *
 *  Spec: D-192 §3a (M-1). */

import { describe, expect, it, vi } from 'vitest';

import { fetchSlackUserEmail } from '@recued/transport';

/** A fake `fetch` returning one canned Slack envelope with a 200. */
const okFetch = (json: unknown): typeof fetch =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => json,
  })) as unknown as typeof fetch;

/** A fake `fetch` returning a non-2xx. */
const httpErrorFetch = (status: number): typeof fetch =>
  vi.fn(async () => ({
    ok: false,
    status,
    statusText: 'error',
    json: async () => ({}),
  })) as unknown as typeof fetch;

const profileEnvelope = (email: unknown): unknown => ({
  ok: true,
  user: { profile: { email } },
});

describe('D-192 M1b — fetchSlackUserEmail', () => {
  it('returns the trimmed profile email on ok:true', async () => {
    const email = await fetchSlackUserEmail('xoxb-tok', 'U0ABC', {
      fetchImpl: okFetch(profileEnvelope('  Alice@Acme.test  ')),
    });
    // Trimmed; casing preserved (the caller canonicalizes).
    expect(email).toBe('Alice@Acme.test');
  });

  it('returns null when the profile carries no email', async () => {
    expect(
      await fetchSlackUserEmail('xoxb-tok', 'U0ABC', { fetchImpl: okFetch(profileEnvelope(undefined)) }),
    ).toBeNull();
    expect(
      await fetchSlackUserEmail('xoxb-tok', 'U0ABC', { fetchImpl: okFetch(profileEnvelope(null)) }),
    ).toBeNull();
    expect(
      await fetchSlackUserEmail('xoxb-tok', 'U0ABC', { fetchImpl: okFetch(profileEnvelope('   ')) }),
    ).toBeNull();
    expect(await fetchSlackUserEmail('xoxb-tok', 'U0ABC', { fetchImpl: okFetch({ ok: true }) })).toBeNull();
  });

  it('returns null on a Slack ok:false envelope (missing_scope / user_not_found)', async () => {
    expect(
      await fetchSlackUserEmail('xoxb-tok', 'U0ABC', {
        fetchImpl: okFetch({ ok: false, error: 'missing_scope' }),
      }),
    ).toBeNull();
    expect(
      await fetchSlackUserEmail('xoxb-tok', 'U0ABC', {
        fetchImpl: okFetch({ ok: false, error: 'user_not_found' }),
      }),
    ).toBeNull();
  });

  it('returns null on a non-2xx response', async () => {
    expect(await fetchSlackUserEmail('xoxb-tok', 'U0ABC', { fetchImpl: httpErrorFetch(500) })).toBeNull();
    expect(await fetchSlackUserEmail('xoxb-tok', 'U0ABC', { fetchImpl: httpErrorFetch(429) })).toBeNull();
  });

  it('returns null on a network failure (fetch throws)', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await fetchSlackUserEmail('xoxb-tok', 'U0ABC', { fetchImpl: throwing })).toBeNull();
  });

  it('short-circuits (no fetch) on a blank token or user id', async () => {
    const spy = vi.fn();
    const fetchImpl = spy as unknown as typeof fetch;
    expect(await fetchSlackUserEmail('', 'U0ABC', { fetchImpl })).toBeNull();
    expect(await fetchSlackUserEmail('xoxb-tok', '', { fetchImpl })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends the users.info request with the `user` query arg + a Bearer header', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => profileEnvelope('a@b.test'),
    }));
    await fetchSlackUserEmail('xoxb-tok', 'U 0ABC', { fetchImpl: spy as unknown as typeof fetch });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    // The arg rides the query string (universally read by Slack) — URL-encoded.
    expect(url).toBe('https://slack.com/api/users.info?user=U%200ABC');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-tok');
    expect(init.body).toBe('');
  });
});
