/** D-240 slice 4 — `until_resolved`: a credential that outlives the request and
 *  then does not.
 *
 *  ⛔⛔ THE BACKSTOP THIS SLICE DEPENDS ON WAS INERT. Slice 2 added `ceiling_at`
 *  and I described it as closing the deferred-credential leak — but
 *  `ReceptionManageCredentialStore.purge` had NO CALLER anywhere outside tests
 *  (D-210 Appendix B shipped the method and never registered it). The collector
 *  is wired in this slice; the tests below assert both halves, because a stamp
 *  that shortens an expiry nothing ever collects is bookkeeping, not retention. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveVisitorLookupExpiry,
  VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
  VISITOR_LOOKUP_DEFAULT_GRACE_MS,
  VISITOR_LOOKUP_SUPPORTED_MODES,
  type VisitorLookupConfig,
} from '@recued/contracts';

import {
  createReceptionManageCredentialStore,
  type ReceptionManageCredentialStore,
} from '../storage/reception-manage-credential-store.js';
import { mintVisitorLookupPath } from '../ports/reception/handlers/visitor-lookup-mint.js';
import {
  runReceptionLookupExpirySweep,
  type ReceptionRecordCompletion,
} from '../reception-lookup-expiry-sweep.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const store = (): ReceptionManageCredentialStore =>
  createReceptionManageCredentialStore(new Database(':memory:'));

const deferredConfig: VisitorLookupConfig = {
  enabled: true,
  expiry: { mode: 'until_resolved', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
};

const mintDeferred = (s: ReceptionManageCredentialStore): string => {
  const path = mintVisitorLookupPath({
    config: deferredConfig, store: s, endpoint_id: 'ep-1', record_id: 'sub-1', now: NOW,
  });
  if (path === null) throw new Error('expected a minted credential');
  return path.slice(path.lastIndexOf('/') + 1);
};

const sweep = (
  s: ReceptionManageCredentialStore,
  completion: ReceptionRecordCompletion | null,
  now = NOW,
) => runReceptionLookupExpirySweep({
  credentialStore: s,
  readCompletion: () => completion,
  now: () => now,
});

describe('D-240 slice 4 — the mode is supported and mintable', () => {
  it('`until_resolved` joined the supported list', () => {
    expect(VISITOR_LOOKUP_SUPPORTED_MODES).toContain('until_resolved');
  });

  it('the resolver reports it DEFERRED, with the grace and a ceiling', () => {
    // ⚠ Its own arm rather than `expires_at: null` — a nullable field would make
    // every consumer handle a null it mostly cannot get.
    expect(resolveVisitorLookupExpiry({ expiry: deferredConfig.expiry, now: NOW })).toEqual({
      kind: 'deferred',
      grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS,
      ceiling_at: NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
    });
  });

  it('⛔ a deferred credential starts at the CEILING, not at a grace from now', () => {
    // There is no anchor yet. Starting it at `now + grace` would expire the link
    // 30 days in, while the request it reports on was still open.
    const s = store();
    const secret = mintDeferred(s);
    expect(s.peek(secret, NOW + 90 * DAY, 'lookup').status).toBe('ok');
    expect(s.peek(secret, NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS + 1, 'lookup').status)
      .toBe('expired');
  });
});

describe('D-240 § D7 — the sweep stamps on `done`, and only on `done`', () => {
  it('an UNRESOLVED record leaves the credential alone', () => {
    const s = store();
    const secret = mintDeferred(s);
    expect(sweep(s, { done: false })).toEqual({ scanned: 1, stamped: 0 });
    // Still live far past the grace, because nothing has ended.
    expect(s.peek(secret, NOW + 90 * DAY, 'lookup').status).toBe('ok');
  });

  it('a record with NO target at all leaves it alone', () => {
    const s = store();
    mintDeferred(s);
    expect(sweep(s, null)).toEqual({ scanned: 1, stamped: 0 });
  });

  it('⛔ a DONE record shortens the expiry to completed_at + grace', () => {
    const s = store();
    const secret = mintDeferred(s);
    const completed_at = NOW + 10 * DAY;
    expect(sweep(s, { done: true, completed_at })).toEqual({ scanned: 1, stamped: 1 });

    expect(s.peek(secret, completed_at + VISITOR_LOOKUP_DEFAULT_GRACE_MS - 1, 'lookup').status)
      .toBe('ok');
    expect(s.peek(secret, completed_at + VISITOR_LOOKUP_DEFAULT_GRACE_MS + 1, 'lookup').status)
      .toBe('expired');
  });

  it('⚠ a `done` entity with no completed_at uses NOW — "done, and we noticed here"', () => {
    const s = store();
    const secret = mintDeferred(s);
    const observedAt = NOW + 5 * DAY;
    sweep(s, { done: true }, observedAt);
    expect(s.peek(secret, observedAt + VISITOR_LOOKUP_DEFAULT_GRACE_MS + 1, 'lookup').status)
      .toBe('expired');
  });

  it('⛔⛔ a `completed_at` FAR IN THE FUTURE cannot push past the ceiling', () => {
    // §D8's clamp. `completed_at` comes from a work entity — not this store's
    // data — so it must not be able to extend a credential beyond the backstop
    // it was minted under. A recipe that wrote a year-out timestamp would
    // otherwise mint itself an unbounded link.
    const s = store();
    const secret = mintDeferred(s);
    sweep(s, { done: true, completed_at: NOW + 5 * 365 * DAY });
    expect(s.peek(secret, NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS + 1, 'lookup').status)
      .toBe('expired');
  });

  it('stamping is ONCE — a second pass no longer sees it', () => {
    const s = store();
    mintDeferred(s);
    expect(sweep(s, { done: true, completed_at: NOW }).stamped).toBe(1);
    expect(sweep(s, { done: true, completed_at: NOW })).toEqual({ scanned: 0, stamped: 0 });
  });

  it('⚠ a NON-deferred credential is never scanned — `fixed` must not be shortened', () => {
    // The permitting case, inverted: if the sweep listed every credential, a
    // fixed-window link would be cut short the moment its record happened to
    // complete, which no config asked for.
    const s = store();
    mintVisitorLookupPath({
      config: { enabled: true, expiry: { mode: 'fixed', ttl_ms: 30 * DAY } },
      store: s, endpoint_id: 'ep-1', record_id: 'sub-2', now: NOW,
    });
    expect(sweep(s, { done: true, completed_at: NOW })).toEqual({ scanned: 0, stamped: 0 });
  });

  it('a reader that THROWS does not abort the pass', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = store();
      mintDeferred(s);
      const out = runReceptionLookupExpirySweep({
        credentialStore: s,
        readCompletion: () => { throw new Error('record store is down'); },
        now: () => NOW,
      });
      expect(out).toEqual({ scanned: 1, stamped: 0 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('completion read failed'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('D-240 § D10 — the collector, which had never run', () => {
  it('⛔⛔ purge reclaims a deferred credential at its CEILING even if never resolved', () => {
    // The abandoned-request case: the approver never answers, so nothing ever
    // stamps it. Without this the row lives forever — and until this slice
    // nothing called `purge` at all.
    const s = store();
    mintDeferred(s);
    expect(s.purge(NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS - 1)).toBe(0);
    expect(s.purge(NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS)).toBe(1);
  });

  it('and reclaims a STAMPED one at its shortened expiry, long before the ceiling', () => {
    const s = store();
    mintDeferred(s);
    const completed_at = NOW + 2 * DAY;
    sweep(s, { done: true, completed_at });
    // Nowhere near the 180-day ceiling.
    expect(s.purge(completed_at + VISITOR_LOOKUP_DEFAULT_GRACE_MS)).toBe(1);
  });

  it('⚠ STAMP-THEN-PURGE is the order that matters', () => {
    // Reversed, a credential whose record just resolved would survive the
    // collector and wait a full interval for the next one — an hour of extra
    // retention on every resolved request, for nothing.
    const s = store();
    mintDeferred(s);
    const completed_at = NOW + DAY;
    const at = completed_at + VISITOR_LOOKUP_DEFAULT_GRACE_MS;
    // Purge FIRST: nothing to collect, because the row still says "ceiling".
    expect(s.purge(at)).toBe(0);
    // Stamp, then purge: gone in the same pass.
    sweep(s, { done: true, completed_at });
    expect(s.purge(at)).toBe(1);
  });
});
