/** D-240 slice 2 — the submit-time mint, the purpose fence, and the backstop.
 *
 *  ⛔⛔ THE PURPOSE FENCE IS THE SECURITY HALF OF THIS SLICE, and it did not
 *  exist before it. Two capabilities share this table, this secret format and
 *  this resolve path: the OWNER's single-use reschedule credential
 *  (`reception.manage.mint`, `requireAdmin`) and the VISITOR's repeatable
 *  read-only viewback credential (minted at submit, handed to an anonymous
 *  stranger). Without a purpose column the second is accepted by the first's
 *  door — a visitor's read link would move the booking. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
  VISITOR_LOOKUP_DEFAULT_GRACE_MS,
  VISITOR_LOOKUP_DEFAULT_TTL_MS,
  VISITOR_LOOKUP_MAX_TTL_MS,
  type VisitorLookupConfig,
} from '@recued/contracts';

import {
  createReceptionManageCredentialStore,
  RECEPTION_CREDENTIAL_MAX_TTL_MS_BY_PURPOSE,
  RECEPTION_MANAGE_MAX_TTL_MS,
  type ReceptionManageCredentialStore,
} from '../storage/reception-manage-credential-store.js';
import {
  mintVisitorLookupPath,
  RECEPTION_LOOKUP_PATH,
} from '../ports/reception/handlers/visitor-lookup-mint.js';

const NOW = 1_700_000_000_000;

const store = (): ReceptionManageCredentialStore =>
  createReceptionManageCredentialStore(new Database(':memory:'));

const issueLookup = (s: ReceptionManageCredentialStore, ttl_ms = VISITOR_LOOKUP_DEFAULT_TTL_MS) =>
  s.issue({
    kind: 'intake_form',
    endpoint_id: 'ep-1',
    record_id: 'sub-1',
    purpose: 'lookup',
    now: NOW,
    ttl_ms,
    ceiling_at: NOW + VISITOR_LOOKUP_ABSOLUTE_CEILING_MS,
  });

const issueManage = (s: ReceptionManageCredentialStore) =>
  s.issue({
    kind: 'scheduling_link',
    endpoint_id: 'ep-1',
    record_id: 'sub-1',
    purpose: 'manage',
    now: NOW,
  });

describe('D-240 § D3 — the purpose fence', () => {
  it('a credential resolves for its OWN purpose', () => {
    // ⚠ The permitting case first — a fence that refused everything would pass
    // every refusal test below while breaking both doors.
    const s = store();
    expect(s.peek(issueLookup(s).secret, NOW, 'lookup').status).toBe('ok');
    expect(s.peek(issueManage(s).secret, NOW, 'manage').status).toBe('ok');
  });

  it('⛔⛔ a VISITOR lookup secret is NOT accepted by the manage door', () => {
    // The escalation this closes: the lookup secret is handed to an anonymous
    // submitter; the manage door moves the booking.
    const s = store();
    const { secret } = issueLookup(s);
    expect(s.peek(secret, NOW, 'manage').status).toBe('not_found');
    expect(s.consume(secret, NOW, 'manage').status).toBe('not_found');
  });

  it('⛔ and an owner manage secret is not accepted by the lookup door either', () => {
    const s = store();
    const { secret } = issueManage(s);
    expect(s.peek(secret, NOW, 'lookup').status).toBe('not_found');
  });

  it('⛔⛔ a rejected consume does NOT BURN the credential', () => {
    // Checking the purpose AFTER the CAS would refuse the call and destroy the
    // credential — a denial of service on the submitter's read access, dressed
    // up as a security check. A scanner POSTing the link would be enough.
    const s = store();
    const { secret } = issueLookup(s);
    expect(s.consume(secret, NOW, 'manage').status).toBe('not_found');
    expect(s.peek(secret, NOW, 'lookup').status).toBe('ok');
  });

  it('reports a purpose mismatch as `not_found`, never as expired/consumed', () => {
    // A holder of a secret for another door must not learn it is live.
    const s = store();
    const { secret } = issueLookup(s);
    s.consume(secret, NOW, 'lookup');
    expect(s.peek(secret, NOW, 'manage').status).toBe('not_found');
  });
});

describe('D-240 — per-purpose TTL ceilings', () => {
  it('the manage ceiling is unchanged and the lookup one is the viewback max', () => {
    expect(RECEPTION_CREDENTIAL_MAX_TTL_MS_BY_PURPOSE.manage).toBe(RECEPTION_MANAGE_MAX_TTL_MS);
    expect(RECEPTION_CREDENTIAL_MAX_TTL_MS_BY_PURPOSE.lookup).toBe(VISITOR_LOOKUP_MAX_TTL_MS);
  });

  it('⛔ a lookup TTL beyond the manage ceiling is ACCEPTED — one global max would not do', () => {
    const s = store();
    const beyondManage = RECEPTION_MANAGE_MAX_TTL_MS + 1;
    expect(() => issueLookup(s, beyondManage)).not.toThrow();
  });

  it('⛔ but a manage TTL beyond ITS ceiling is still refused — the loosening is scoped', () => {
    const s = store();
    expect(() => s.issue({
      kind: 'scheduling_link', endpoint_id: 'ep-1', record_id: 'sub-1',
      purpose: 'manage', now: NOW, ttl_ms: RECEPTION_MANAGE_MAX_TTL_MS + 1,
    })).toThrow(/ttl_ms out of range/);
  });

  it('refuses an unknown purpose rather than storing it', () => {
    const s = store();
    expect(() => s.issue({
      kind: 'intake_form', endpoint_id: 'ep-1', record_id: 'sub-1',
      purpose: 'whatever' as never, now: NOW,
    })).toThrow(/not a reception credential purpose/);
  });
});

describe('D-240 § D10 — the ceiling and the purge backstop', () => {
  it('a ceiling is always returned, and never below the expiry', () => {
    const s = store();
    const issued = issueLookup(s);
    expect(issued.ceiling_at).toBeGreaterThanOrEqual(issued.expires_at);
  });

  it('⛔ a ceiling BELOW the expiry is raised to it, never honoured', () => {
    // A ceiling inside the expiry would collect a live credential early and the
    // visitor would have no way to see why the link died before its stated date.
    const s = store();
    const issued = s.issue({
      kind: 'intake_form', endpoint_id: 'ep-1', record_id: 'sub-1',
      purpose: 'lookup', now: NOW, ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS,
      ceiling_at: NOW + 1000,
    });
    expect(issued.ceiling_at).toBe(issued.expires_at);
  });

  it('purge collects an EXPIRED credential', () => {
    const s = store();
    const issued = issueLookup(s);
    expect(s.purge(issued.expires_at)).toBe(1);
  });

  it('⛔⛔ and purge ALSO collects on the ceiling — the deferred-row backstop', () => {
    // The reason `ceiling_at` exists at all: slice 4's `until_resolved` has no
    // `expires_at` until its record flips `done`, and a NULL matches no
    // comparison. Asserted on the ceiling predicate independently so the
    // backstop is proven before the arm that needs it exists.
    const s = store();
    const issued = issueLookup(s);
    // Not yet expired, so only the ceiling clause can collect it.
    expect(s.purge(issued.expires_at - 1)).toBe(0);
    expect(s.purge(issued.ceiling_at)).toBe(1);
  });
});

describe('D-240 slice 2 — mintVisitorLookupPath', () => {
  const enabled: VisitorLookupConfig = {
    enabled: true,
    expiry: { mode: 'fixed', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS },
  };
  const args = (over: Record<string, unknown> = {}) => ({
    config: enabled,
    store: store(),
    endpoint_id: 'ep-1',
    record_id: 'sub-1',
    now: NOW,
    ...over,
  });

  it('mints a path under the lookup route', () => {
    const path = mintVisitorLookupPath(args());
    expect(path).toMatch(new RegExp(`^${RECEPTION_LOOKUP_PATH}/recued_manage_[A-Za-z0-9_-]{43}$`));
  });

  it('the minted credential carries the LOOKUP purpose, not manage', () => {
    const s = store();
    const path = mintVisitorLookupPath(args({ store: s }))!;
    const secret = path.slice(`${RECEPTION_LOOKUP_PATH}/`.length);
    expect(s.peek(secret, NOW, 'lookup').status).toBe('ok');
    expect(s.peek(secret, NOW, 'manage').status).toBe('not_found');
  });

  it('mints nothing when disabled, absent, or with no store wired', () => {
    expect(mintVisitorLookupPath(args({ config: { ...enabled, enabled: false } }))).toBeNull();
    expect(mintVisitorLookupPath(args({ config: undefined }))).toBeNull();
    expect(mintVisitorLookupPath(args({ store: undefined }))).toBeNull();
  });

  it('`after_event` anchors on the slot, and REFUSES loudly with no slot', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg: VisitorLookupConfig = {
        enabled: true,
        expiry: { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS },
      };
      const slot_end_at = NOW + 3 * 24 * 60 * 60 * 1000;
      expect(mintVisitorLookupPath(args({
        config: cfg, record_kind: 'scheduling_link', slot_end_at,
      }))).not.toBeNull();
      // No slot ⇒ no silent re-anchor onto `now`, and it SAYS so.
      expect(mintVisitorLookupPath(args({ config: cfg, record_kind: 'scheduling_link' }))).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('anchor_missing'));
    } finally {
      warn.mockRestore();
    }
  });

  it('⛔⛔ NEVER THROWS — the submission is already committed by then', () => {
    // A throw here turns a recorded submission into an error page: the visitor
    // is told their request failed when it did not, and re-submits.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const exploding = {
        issue: () => { throw new Error('disk is on fire'); },
      } as unknown as ReceptionManageCredentialStore;
      expect(() => mintVisitorLookupPath(args({ store: exploding }))).not.toThrow();
      expect(mintVisitorLookupPath(args({ store: exploding }))).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('mint failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('⚠ EVERY mode mints now — the unsupported branch has no live case', () => {
    // This named `until_resolved` until slice 4 and `after_field` until slice 5;
    // both are built, so there is no unbuildable mode left to assert on.
    // Re-aimed at the property that survives: each of the four modes, given what
    // it needs, produces a link. A mode that stopped minting would be a viewback
    // silently never issued.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(mintVisitorLookupPath(args())).not.toBeNull();
      expect(mintVisitorLookupPath(args({
        config: { enabled: true, expiry: { mode: 'until_resolved', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS } },
      }))).not.toBeNull();
      expect(mintVisitorLookupPath(args({
        config: { enabled: true, expiry: { mode: 'after_field', field: 'when', ttl_ms: VISITOR_LOOKUP_DEFAULT_TTL_MS } },
        field_values: { when: '2026-06-15' },
      }))).not.toBeNull();
      expect(mintVisitorLookupPath(args({
        config: { enabled: true, expiry: { mode: 'after_event', grace_ms: VISITOR_LOOKUP_DEFAULT_GRACE_MS } },
        record_kind: 'scheduling_link',
        slot_end_at: NOW + 86_400_000,
      }))).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
