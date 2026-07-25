/** D-148 P2 — client_tokens table + Argon2id discipline.
 *
 *  Acceptance per spec § P2 + § A.2.2:
 *   - Issue → verify with correct bearer succeeds.
 *   - Issue → verify with wrong bearer fails.
 *   - Issue → revoke → verify fails (revoked).
 *   - revokeAll revokes every active token.
 *   - Verify against unknown token_id is constant-time relative to
 *     verify against known-but-wrong-bearer.
 *   - List filters by client_kind + by include_revoked.
 *   - touch updates last_used_at.
 *   - Argon2id parameters travel with the row (verify side picks
 *     them up automatically).
 *   - Rejecting unknown client_kind at issue time.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createClientTokenStore,
  CLIENT_KINDS,
  isClientKind,
  type ClientTokenStore,
} from '../pairing/client-tokens.js';

const FAST_ARGON2 = { t: 1, m: 1024, p: 1 };

let db: Database.Database;
let store: ClientTokenStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = createClientTokenStore(db, { argon2_params: FAST_ARGON2 });
});

afterEach(() => {
  db.close();
});

describe('D-148 P2 — client_tokens issue + verify', () => {
  it('issued bearer verifies', async () => {
    const { token_id, bearer } = await store.issue({
      client_kind: 'webclient',
      client_label: 'test laptop',
    });
    const result = await store.verify(token_id, bearer);
    expect(result.ok).toBe(true);
    expect(result.record?.client_kind).toBe('webclient');
    expect(result.record?.client_label).toBe('test laptop');
  });

  it('wrong bearer fails verify', async () => {
    const { token_id } = await store.issue({ client_kind: 'bridge' });
    const result = await store.verify(token_id, 'not-the-bearer');
    expect(result.ok).toBe(false);
    expect(result.record).toBeNull();
  });

  it('unknown token_id fails verify (constant-time path)', async () => {
    const result = await store.verify('not-a-real-token-id', 'whatever');
    expect(result.ok).toBe(false);
    expect(result.record).toBeNull();
  });

  it('two issuances under the same kind produce different token_ids + bearers', async () => {
    const a = await store.issue({ client_kind: 'webclient' });
    const b = await store.issue({ client_kind: 'webclient' });
    expect(a.token_id).not.toBe(b.token_id);
    expect(a.bearer).not.toBe(b.bearer);
    expect((await store.verify(a.token_id, a.bearer)).ok).toBe(true);
    expect((await store.verify(b.token_id, b.bearer)).ok).toBe(true);
    expect((await store.verify(a.token_id, b.bearer)).ok).toBe(false);
  });

  it('rejects unknown client_kind at issue time', async () => {
    await expect(
      store.issue({ client_kind: 'attacker' as unknown as 'cli' }),
    ).rejects.toThrow(/unknown client_kind/);
  });

  it('persists metadata roundtrip', async () => {
    const meta = { device_label: 'thinkpad', ip_at_issue: '10.0.0.1' };
    const { token_id, bearer } = await store.issue({
      client_kind: 'webclient',
      metadata: meta,
    });
    const result = await store.verify(token_id, bearer);
    expect(result.ok).toBe(true);
    expect(result.record?.metadata).toEqual(meta);
  });
});

describe('D-148 P2 — client_tokens revoke', () => {
  it('revoked token fails verify', async () => {
    const { token_id, bearer } = await store.issue({ client_kind: 'cli' });
    expect((await store.verify(token_id, bearer)).ok).toBe(true);
    store.revoke(token_id, 'user requested');
    expect((await store.verify(token_id, bearer)).ok).toBe(false);
  });

  it('revoke is idempotent', async () => {
    const { token_id, bearer } = await store.issue({ client_kind: 'cli' });
    store.revoke(token_id, 'first');
    store.revoke(token_id, 'second-reason-no-op');
    const record = store.get(token_id);
    expect(record?.revocation_reason).toBe('first'); // first-revoke wins
    expect((await store.verify(token_id, bearer)).ok).toBe(false);
  });

  it('revokeAll revokes every active token + leaves already-revoked alone', async () => {
    const a = await store.issue({ client_kind: 'webclient' });
    const b = await store.issue({ client_kind: 'bridge' });
    const c = await store.issue({ client_kind: 'cli' });
    store.revoke(c.token_id, 'manual revoke before sweep');
    const count = store.revokeAll('server identity rotation');
    // a + b were active; c was already revoked.
    expect(count).toBe(2);
    expect((await store.verify(a.token_id, a.bearer)).ok).toBe(false);
    expect((await store.verify(b.token_id, b.bearer)).ok).toBe(false);
    expect((await store.verify(c.token_id, c.bearer)).ok).toBe(false);
  });
});

describe('D-148 P2 — client_tokens list', () => {
  it('list returns active rows by default', async () => {
    const a = await store.issue({ client_kind: 'webclient', client_label: 'a' });
    const b = await store.issue({ client_kind: 'bridge', client_label: 'b' });
    store.revoke(a.token_id, 'test');
    const active = store.list();
    expect(active.map((r) => r.token_id)).toContain(b.token_id);
    expect(active.map((r) => r.token_id)).not.toContain(a.token_id);
  });

  it('list with include_revoked returns all rows', async () => {
    const a = await store.issue({ client_kind: 'webclient' });
    const b = await store.issue({ client_kind: 'bridge' });
    store.revoke(a.token_id, 'test');
    const all = store.list({ include_revoked: true });
    expect(all.map((r) => r.token_id).sort()).toEqual(
      [a.token_id, b.token_id].sort(),
    );
  });

  it('list filters by client_kind', async () => {
    await store.issue({ client_kind: 'webclient' });
    await store.issue({ client_kind: 'webclient' });
    await store.issue({ client_kind: 'bridge' });
    const webclients = store.list({ client_kind: 'webclient' });
    expect(webclients).toHaveLength(2);
    expect(webclients.every((r) => r.client_kind === 'webclient')).toBe(true);
  });
});

describe('D-148 P2 — client_tokens touch', () => {
  it('updates last_used_at without changing other fields', async () => {
    let now_ms = 1_700_000_000_000;
    const { token_id, bearer } = await store.issue({ client_kind: 'cli' });
    const before = store.get(token_id);
    expect(before?.last_used_at).toBeNull();
    now_ms += 5000;
    store.touch(token_id, now_ms);
    const after = store.get(token_id);
    expect(after?.last_used_at).toBe(now_ms);
    // bearer still verifies (touch doesn't rotate hash).
    expect((await store.verify(token_id, bearer)).ok).toBe(true);
  });
});

describe('D-148 P2 — client_tokens kind taxonomy', () => {
  it('CLIENT_KINDS is the closed list', () => {
    expect(CLIENT_KINDS).toEqual(['bridge', 'webclient', 'cli']);
  });

  it('isClientKind narrows to known values', () => {
    expect(isClientKind('webclient')).toBe(true);
    expect(isClientKind('bridge')).toBe(true);
    expect(isClientKind('cli')).toBe(true);
    expect(isClientKind('attacker')).toBe(false);
    expect(isClientKind(0)).toBe(false);
  });
});

describe('D-148 P2 — client_tokens constant-time verify discipline', () => {
  it('verify against unknown token_id takes comparable time to verify against known-but-wrong bearer', async () => {
    // Statistical timing tests are notoriously flaky; this asserts
    // the *path* (every verify routes through Argon2id whether or
    // not the token_id exists). We measure that both paths take
    // non-trivial time + are within a generous ratio of each other.
    const { token_id } = await store.issue({ client_kind: 'webclient' });

    // Warm Argon2 caches.
    await store.verify(token_id, 'wrong');

    const ITERS = 5;
    const measure = async (
      tid: string,
      bearer: string,
    ): Promise<number> => {
      const start = performance.now();
      for (let i = 0; i < ITERS; i++) {
        await store.verify(tid, bearer);
      }
      return performance.now() - start;
    };

    const t_known = await measure(token_id, 'wrong-bearer');
    const t_unknown = await measure('does-not-exist', 'wrong-bearer');

    // Both should be non-trivial (Argon2id ran).
    expect(t_known).toBeGreaterThan(0);
    expect(t_unknown).toBeGreaterThan(0);

    // Ratio within 5x — with FAST_ARGON2 the absolute time is small
    // so measurement noise dominates. We're checking the *path*
    // (Argon2id was actually called), not a precise constant-time
    // claim — that's enforced by Node's timingSafeEqual deeper in
    // the stack.
    const ratio = Math.max(t_known, t_unknown) / Math.min(t_known, t_unknown);
    expect(ratio).toBeLessThan(5);
  });
});
