/** D-240 slice 6 — `reception.lookup.revoke`: ending ONE submitter's access.
 *
 *  ⛔⛔ THIS IS WHAT MAKES A LONG-LIVED UNAUTHENTICATED CREDENTIAL SURVIVABLE.
 *  § D3 ruled the viewback URL is the whole authority and § D6/4/5 let it live
 *  for weeks. At 24 hours you can wait a bad link out; at six weeks you need to
 *  be able to end it — and `reception.endpoint.rotate_token` is per-ENDPOINT, so
 *  reaching for that would cut off every submitter to kill one. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import {
  createReceptionManageCredentialStore,
  type ReceptionManageCredentialStore,
} from '../storage/reception-manage-credential-store.js';
import {
  handleReceptionLookupRevoke,
  makeReceptionLookupRevokeHandlers,
  ReceptionLookupRevokeRpcError,
} from '../reception-lookup-revoke-handler.js';

const NOW = 1_700_000_000_000;
const ADMIN = { instance_id: 'client-1' };

const store = (): ReceptionManageCredentialStore =>
  createReceptionManageCredentialStore(new Database(':memory:'));

const lookupFor = (
  s: ReceptionManageCredentialStore,
  record_id: string,
  endpoint_id = 'ep-1',
) => s.issue({
  kind: 'intake_form', endpoint_id, record_id, purpose: 'lookup', now: NOW,
  ttl_ms: 30 * 24 * 60 * 60 * 1000,
});

const manageFor = (s: ReceptionManageCredentialStore, record_id: string) =>
  s.issue({
    kind: 'scheduling_link', endpoint_id: 'ep-1', record_id, purpose: 'manage', now: NOW,
  });

/** ⛔⛔ TWO HELPERS, BECAUSE A DEFAULT PARAMETER SWALLOWS AN EXPLICIT `undefined`.
 *  The first version of this file had one helper with `caller = ADMIN`, so
 *  `revoke(s, args, undefined)` passed ADMIN — and the two gate tests below ran
 *  the AUTHENTICATED path while claiming to test the unauthenticated one. They
 *  failed loudly here, which is the good case; a weaker assertion would have
 *  gone green and left the admin gate untested.
 *  ⇒ The caller is REQUIRED where it is the subject. */
const revokeAs = (
  caller: { instance_id?: string | null } | undefined,
  s: ReceptionManageCredentialStore,
  args: { endpoint_id?: string; record_id?: string },
) => handleReceptionLookupRevoke(
  { getCredentialStore: () => s, now: () => NOW },
  args as { endpoint_id: string; record_id: string },
  caller,
);

const revoke = (
  s: ReceptionManageCredentialStore,
  args: { endpoint_id?: string; record_id?: string },
) => revokeAs(ADMIN, s, args);

describe('D-240 § D11 — the revoke ends exactly one submitter', () => {
  it('revokes the named record\'s viewback, and the link stops resolving', () => {
    const s = store();
    const { secret } = lookupFor(s, 'sub-1');
    expect(s.peek(secret, NOW, 'lookup').status).toBe('ok');

    expect(revoke(s, { endpoint_id: 'ep-1', record_id: 'sub-1' })).toEqual({ revoked: 1 });
    expect(s.peek(secret, NOW, 'lookup').status).toBe('already_consumed');
  });

  it('⛔⛔ leaves ANOTHER submitter\'s link alone — the whole reason it is per-record', () => {
    // Rotating the endpoint token would kill both. That is the alternative this
    // rpc exists to avoid, so it is the assertion that matters most.
    const s = store();
    const mine = lookupFor(s, 'sub-1');
    const theirs = lookupFor(s, 'sub-2');

    revoke(s, { endpoint_id: 'ep-1', record_id: 'sub-1' });

    expect(s.peek(mine.secret, NOW, 'lookup').status).toBe('already_consumed');
    expect(s.peek(theirs.secret, NOW, 'lookup').status).toBe('ok');
  });

  it('⛔⛔ leaves the OWNER\'s manage link on the same record alone', () => {
    // A record can carry both capabilities at once. Revoking "this record's
    // credentials" without the purpose predicate would kill the owner's own
    // reschedule link — possibly mid-reschedule — as a side effect of cutting
    // off a stranger. The read-time fence has to hold at revoke time too.
    const s = store();
    const visitor = lookupFor(s, 'sub-1');
    const owner = manageFor(s, 'sub-1');

    revoke(s, { endpoint_id: 'ep-1', record_id: 'sub-1' });

    expect(s.peek(visitor.secret, NOW, 'lookup').status).toBe('already_consumed');
    expect(s.peek(owner.secret, NOW, 'manage').status).toBe('ok');
  });

  it('⚠ revokes EVERY live link for the record, not just one', () => {
    // Nothing stops a record being minted twice, and an owner who says "cut this
    // person off" means all of them. A revoke that left a second live link would
    // be worse than none.
    const s = store();
    const a = lookupFor(s, 'sub-1');
    const b = lookupFor(s, 'sub-1');

    expect(revoke(s, { endpoint_id: 'ep-1', record_id: 'sub-1' })).toEqual({ revoked: 2 });
    expect(s.peek(a.secret, NOW, 'lookup').status).toBe('already_consumed');
    expect(s.peek(b.secret, NOW, 'lookup').status).toBe('already_consumed');
  });

  it('⛔ scopes on the ENDPOINT too — the same record id under another endpoint survives', () => {
    // The credential's scope is `(endpoint_id, record_id)`; matching on the
    // record alone would be a different predicate from the one `peek` resolves
    // on, and two predicates over one key space is how a revoke starts missing
    // rows — or hitting extra ones.
    const s = store();
    const here = lookupFor(s, 'sub-1', 'ep-1');
    const elsewhere = lookupFor(s, 'sub-1', 'ep-2');

    revoke(s, { endpoint_id: 'ep-1', record_id: 'sub-1' });

    expect(s.peek(here.secret, NOW, 'lookup').status).toBe('already_consumed');
    expect(s.peek(elsewhere.secret, NOW, 'lookup').status).toBe('ok');
  });
});

describe('D-240 § D11 — 0 is a success', () => {
  it('a record with no link reports 0 rather than failing', () => {
    // The owner's intent — "this link must not work" — is satisfied. Reporting a
    // failure would send them looking for a problem that does not exist.
    expect(revoke(store(), { endpoint_id: 'ep-1', record_id: 'nobody' }))
      .toEqual({ revoked: 0 });
  });

  it('a second revoke is idempotent and does not re-stamp the time', () => {
    const s = store();
    lookupFor(s, 'sub-1');
    expect(revoke(s, { endpoint_id: 'ep-1', record_id: 'sub-1' })).toEqual({ revoked: 1 });
    expect(revoke(s, { endpoint_id: 'ep-1', record_id: 'sub-1' })).toEqual({ revoked: 0 });
  });

  it('⚠ does NOT require the record to still exist', () => {
    // Deliberate: a record collected by retention whose link is still in
    // someone's inbox is exactly when a revoke is most wanted. This store has no
    // submission rows at all and the call still works.
    const s = store();
    lookupFor(s, 'sub-ghost');
    expect(revoke(s, { endpoint_id: 'ep-1', record_id: 'sub-ghost' })).toEqual({ revoked: 1 });
  });
});

describe('D-240 § D11 — the gate and the shape', () => {
  it('⛔ refuses an unregistered caller — the reserved prefix is a CHANNEL fence, not an actor one', () => {
    for (const caller of [undefined, {}, { instance_id: null }]) {
      expect(
        () => revokeAs(caller, store(), { endpoint_id: 'ep-1', record_id: 'sub-1' }),
        `caller ${JSON.stringify(caller)} was admitted`,
      ).toThrow(ReceptionLookupRevokeRpcError);
    }
  });

  it('refuses a missing or blank id rather than revoking something else', () => {
    const s = store();
    // ⚠ Whitespace-only and over-long ids added: the handler used to check bare
    // `length`, so `'   '` and a 10 KB id reached the STORE and surfaced as
    // `ReceptionManageCredentialValidationError` — an error this rpc never
    // declared. Now both map to `reception_lookup_revoke_invalid`.
    for (const args of [
      {}, { endpoint_id: 'ep-1' }, { record_id: 'sub-1' },
      { endpoint_id: '', record_id: 'sub-1' }, { endpoint_id: 'ep-1', record_id: '' },
      { endpoint_id: '   ', record_id: 'sub-1' },
      { endpoint_id: 'ep-1', record_id: 'x'.repeat(300) },
    ]) {
      // ⚠ Asserted on the CODE, not the prose — the three shapes (not a string,
      // blank, too long) have different messages and one regex over all of them
      // would either be so loose it matched anything or would break on the next
      // wording change. The contract's promise is the code.
      let code = '';
      try { revoke(s, args); } catch (e) { code = (e as ReceptionLookupRevokeRpcError).code; }
      expect(code, `args ${JSON.stringify(args)} were accepted`)
        .toBe('reception_lookup_revoke_invalid');
    }
  });

  it('⚠ the admin gate runs BEFORE the shape check', () => {
    // An unregistered caller must not be able to probe argument validity.
    let code = '';
    try {
      revokeAs(undefined, store(), {});
    } catch (e) {
      code = (e as ReceptionLookupRevokeRpcError).code;
    }
    expect(code).toBe('permission_denied');
  });
});

describe('D-240 § D11 — the rpc slice reaches the wire', () => {
  it('⛔⛔ REGISTERS the method — a conditional spread cannot be typechecked', () => {
    // `compose-listeners` supplies these deps through a conditional SPREAD, and a
    // spread skips TypeScript's excess-property check — "the same shape that
    // left `receptionManageMintDeps` dead on the wire", as that file records. So
    // the guard here is not a type; it is this assertion.
    const slice = makeReceptionLookupRevokeHandlers({
      getCredentialStore: () => store(), now: () => NOW,
    });
    expect(slice?.methods).toEqual(['reception.lookup.revoke']);
    expect(typeof slice?.handlers['reception.lookup.revoke']).toBe('function');
  });

  it('⚠ and is NOT registered without deps — the db-less posture', () => {
    expect(makeReceptionLookupRevokeHandlers(undefined)).toBeUndefined();
  });

  it('the registered handler carries the caller through to the gate', async () => {
    const slice = makeReceptionLookupRevokeHandlers<{ instance_id?: string | null }>({
      getCredentialStore: () => store(), now: () => NOW,
    });
    await expect(
      slice!.handlers['reception.lookup.revoke'](
        { endpoint_id: 'ep-1', record_id: 'sub-1' },
        undefined,
      ),
    ).rejects.toThrow(/requires a paired admin client/);
  });
});
