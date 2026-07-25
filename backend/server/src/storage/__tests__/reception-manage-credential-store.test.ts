/** D-210 Appendix B — the manage-credential store's security invariants:
 *  a GET-safe (non-consuming) peek, an atomic single-use consume, expiry, and
 *  scope integrity. These are the properties the public /reception/manage page
 *  leans on — a replayable or retargetable credential would be the whole bug. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RECEPTION_MANAGE_SECRET_PREFIX,
  ReceptionManageCredentialValidationError,
  createReceptionManageCredentialStore,
  generateReceptionManageSecret,
  isReceptionManageSecret,
  type ReceptionManageCredentialStore,
} from '../reception-manage-credential-store.js';

const T0 = 1_700_000_000_000;
const SCOPE = { kind: 'scheduling_link', endpoint_id: 'ep_1', record_id: 'booking_42' } as const;

describe('reception manage-credential store', () => {
  let db: Database.Database;
  let store: ReceptionManageCredentialStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createReceptionManageCredentialStore(db);
  });
  afterEach(() => db.close());

  it('issues a prefixed secret bound to a record scope', () => {
    const issued = store.issue({ ...SCOPE, now: T0 });
    expect(issued.secret.startsWith(RECEPTION_MANAGE_SECRET_PREFIX)).toBe(true);
    expect(isReceptionManageSecret(issued.secret)).toBe(true);
    expect(issued.credential_id).toMatch(/[0-9a-f-]{36}/);
    expect(issued.expires_at).toBeGreaterThan(T0);

    const peeked = store.peek(issued.secret, T0);
    expect(peeked).toMatchObject({ status: 'ok', scope: SCOPE });
  });

  it('peek is NON-consuming — a GET can be repeated, a mail scanner cannot burn it', () => {
    const { secret } = store.issue({ ...SCOPE, now: T0 });
    expect(store.peek(secret, T0).status).toBe('ok');
    expect(store.peek(secret, T0).status).toBe('ok');
    // A later POST still consumes cleanly.
    expect(store.consume(secret, T0).status).toBe('ok');
  });

  it('consume is single-use — the second POST is refused, never a second move', () => {
    const { secret } = store.issue({ ...SCOPE, now: T0 });
    const first = store.consume(secret, T0);
    expect(first).toMatchObject({ status: 'ok', scope: SCOPE });
    expect(store.consume(secret, T0).status).toBe('already_consumed');
    // And a peek after consume reports the spent state, never a usable scope.
    const after = store.peek(secret, T0);
    expect(after.status).toBe('already_consumed');
    expect(after).not.toHaveProperty('scope');
  });

  it('an expired credential neither peeks nor consumes', () => {
    const { secret, expires_at } = store.issue({ ...SCOPE, now: T0, ttl_ms: 1000 });
    expect(store.peek(secret, expires_at + 1).status).toBe('expired');
    const consumed = store.consume(secret, expires_at + 1);
    expect(consumed.status).toBe('expired');
    expect(consumed).not.toHaveProperty('scope');
  });

  it('an unknown or malformed secret is not_found — never a scope', () => {
    expect(store.peek(generateReceptionManageSecret(), T0).status).toBe('not_found');
    expect(store.consume('not-a-manage-secret', T0).status).toBe('not_found');
    expect(store.peek(`${RECEPTION_MANAGE_SECRET_PREFIX}short`, T0).status).toBe('not_found');
  });

  it('refuses to issue for a non-record kind', () => {
    expect(() =>
      store.issue({ kind: 'drop_link' as never, endpoint_id: 'ep_1', record_id: 'r', now: T0 }),
    ).toThrow(ReceptionManageCredentialValidationError);
  });

  it('two credentials for the same record are independent single-uses', () => {
    const a = store.issue({ ...SCOPE, now: T0 });
    const b = store.issue({ ...SCOPE, now: T0 });
    expect(a.secret).not.toEqual(b.secret);
    expect(store.consume(a.secret, T0).status).toBe('ok');
    // Consuming A leaves B live — a re-mint after one use still works.
    expect(store.peek(b.secret, T0).status).toBe('ok');
  });

  it('purge drops only expired rows', () => {
    const live = store.issue({ ...SCOPE, now: T0, ttl_ms: 10_000 });
    const dead = store.issue({ ...SCOPE, now: T0, ttl_ms: 1000 });
    const removed = store.purge(T0 + 5000);
    expect(removed).toBe(1);
    expect(store.peek(live.secret, T0 + 5000).status).toBe('ok');
    expect(store.peek(dead.secret, T0 + 5000).status).toBe('not_found');
  });
});
