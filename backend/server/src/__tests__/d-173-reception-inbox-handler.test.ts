/** D-173 P2 / P3-rpc — reception.inbox.* handler + the N.5 BOUNDARY MUST.
 *
 *  Exercises the working review-then-approve inbox over REAL in-memory
 *  `CheckpointStore` + `AuditLogStore` substrate (so the boundary is
 *  tested against the real narrow `setArgOverrides` writer, not a mock),
 *  with injected stubs for the shared `resolveArgEditSchema` seam (Lane
 *  P), the source-record join, `submitAnswer` (the existing resume path),
 *  the subview store, and the broadcast.
 *
 *  The security assertions (the heart of this lane):
 *   - ONLY `reception.inbox.approve` writes `checkpoint.arg_overrides`
 *     (list / reject never do; before approve the field is absent).
 *   - a non-allowlisted edit key is REJECTED (`edit_not_allowed`) and
 *     NOTHING is written to the checkpoint.
 *   - the held-op query filters to incoming-trigger origin (a non-
 *     reception gated op never appears).
 *   - the scan-gate refuses a pending attachment.
 *   - reject → subview + frees the slot + answers `'deny'`. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ArgEditSchema,
  Checkpoint,
  ExecutionSource,
  ReceptionInboxTopTierKind,
} from '@recued/contracts';
import { RpcError } from '@recued/contracts';
import {
  createAuditLogStore,
  createCheckpointStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
} from '@recued/storage';

import type { PendingAsk } from '@recued/notification';

import { createAskLandingEditApproval } from '../ask-landing-edit-approval.js';
import { createAskLandingDetailResolver } from '../ask-landing-held-op-details.js';
import {
  defaultIsReceptionOriginAnchor,
  defaultResolveInboxSource,
  findReceptionHoldItem,
  handleReceptionInboxApprove,
  handleReceptionInboxList,
  handleReceptionInboxReject,
  pingReceptionInbox,
  purgeReceptionInboxSubview,
  queryReceptionInboxHeldOps,
  recomputeApprovedTarget,
  validateEditsAgainstSchema,
  type RaiseInboxPingAsk,
  type ReceptionInboxBroadcastEvent,
  type ReceptionInboxDeps,
  type ReceptionInboxSubviewStore,
  type ResolvedInboxSource,
} from '../reception-inbox-handler.js';

// ────────────────────────────────────────────────────────────────
// Fixtures + a tiny in-memory subview store
// ────────────────────────────────────────────────────────────────

const ADMIN = { instance_id: 'instance-admin' };
const NOW = 1_700_000_000_000;

const receptionSource: ExecutionSource = {
  channel: 'reactive',
  actor: 'system',
  event_kind: 'reception.intake_form.submitted',
  source_recipe: 'recued-core/reception-intake-incoming',
};

const nonReceptionSource: ExecutionSource = {
  channel: 'reactive',
  actor: 'system',
  event_kind: 'mail.created',
  source_recipe: 'recued-core/detect-deal-risk',
};

const mkAnchor = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: 'run-1',
  recipe_id: 'recued-core/reception-intake-incoming',
  recipe_hash: 'hash-1',
  started_at: NOW,
  finished_at: NOW,
  duration_ms: 0,
  commit_status: 'awaiting_approval',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: 'reactive',
  instance_id: null,
  execution_source: receptionSource,
  ask_id: 'ask-1',
  checkpoint_id: 'cp-1',
  ...overrides,
});

const mkCheckpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'cp-1',
  run_id: 'run-1',
  recipe_id: 'recued-core/reception-intake-incoming',
  gated_step_id: 'materialize',
  approved_target: {
    ingredient_slug: 'recued-core/reception-intake',
    operation_id: 'reception-intake.create_commitment',
    connection_name: 'cal-default',
  },
  step_state: {
    materialize: { input: { title: 'Coffee chat', start_at: 0, calendar_id: 'cal-a' } },
  },
  created_at: NOW,
  ...overrides,
});

/** The resolver stub (Lane P's seam). Returns a fixed allowlist:
 *  `start_at` (editable, datetime) + `calendar_id` (editable,
 *  affects_target). `title` is deliberately NOT in the allowlist (it is
 *  immutable — the non-allowlisted-edit rejection target). */
const allowlistSchema: ArgEditSchema = {
  fields: [
    { key: 'start_at', type: 'datetime', label: 'Start', required: true },
    { key: 'calendar_id', type: 'string', label: 'Calendar', affects_target: true },
  ],
};
const resolverStub = vi.fn(() => allowlistSchema);

/** A source-join stub that surfaces the gated step's prefilled args +
 *  an optional attachment. */
const makeSourceResolver =
  (
    attachment?: ResolvedInboxSource['attachment'],
    topTierKind: ReceptionInboxTopTierKind = 'commitment',
    sourceKind: ResolvedInboxSource['source']['kind'] = 'intake_form',
  ) =>
  ({ checkpoint }: { anchor: AuditEntry; checkpoint: Checkpoint }): ResolvedInboxSource | null => {
    const gated =
      checkpoint.gated_step_id !== undefined
        ? (checkpoint.step_state[checkpoint.gated_step_id] as
            | { input?: Record<string, unknown> }
            | undefined)
        : undefined;
    return {
      top_tier_kind: topTierKind,
      source: { kind: sourceKind, endpoint_id: 'ep-1', record_ref: checkpoint.checkpoint_id },
      args: gated?.input ?? {},
      preview: { title: 'Incoming request' },
      proposed_action: 'Create a commitment',
      ...(attachment !== undefined ? { attachment } : {}),
    };
  };

const makeSubviewStore = (): ReceptionInboxSubviewStore & {
  rows: Array<{ hold_id: string; status: 'dismissed' | 'expired'; top_tier_kind: ReceptionInboxTopTierKind; reason?: string; source_record_ref: string; dismissed_at: number; door_contract_id?: string }>;
} => {
  const rows: Array<{ hold_id: string; status: 'dismissed' | 'expired'; top_tier_kind: ReceptionInboxTopTierKind; reason?: string; source_record_ref: string; dismissed_at: number; door_contract_id?: string }> = [];
  return {
    rows,
    record(row) {
      rows.push(row);
    },
    list(limit) {
      return rows.slice(0, limit).reverse();
    },
    // Mirrors the real store's rule: `'dismissed'` only (an `'expired'` row is
    // the clock's doing, not the owner's), windowed, and a NULL/absent door
    // matches no id.
    countRejectsForDoor(door_contract_id, since_ms) {
      const hits = rows.filter(
        (r) =>
          r.door_contract_id === door_contract_id
          && r.status === 'dismissed'
          && r.dismissed_at >= since_ms,
      );
      return {
        count: hits.length,
        ...(hits.length > 0
          ? { last_rejected_at: Math.max(...hits.map((r) => r.dismissed_at)) }
          : {}),
      };
    },
    purgeOlderThan(cutoff) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i]!.dismissed_at < cutoff) rows.splice(i, 1);
      }
      return before - rows.length;
    },
  };
};

interface Harness {
  deps: ReceptionInboxDeps;
  auditLog: AuditLogStore;
  checkpointStore: CheckpointStore;
  subviewStore: ReturnType<typeof makeSubviewStore>;
  submitAnswer: ReturnType<typeof vi.fn>;
  broadcasts: ReceptionInboxBroadcastEvent[];
}

const makeHarness = (
  opts: {
    attachment?: ResolvedInboxSource['attachment'];
    resolver?: typeof resolverStub;
    topTierKind?: ReceptionInboxTopTierKind;
    sourceKind?: ResolvedInboxSource['source']['kind'];
    lookupBookingHistory?: ReceptionInboxDeps['lookupBookingHistory'];
    resolveFormResponseEdit?: ReceptionInboxDeps['resolveFormResponseEdit'];
    /** D-177 N.14 — wire the allow-offer read (absent ⇒ no affordance +
     *  `allow: true` refuses, the fail-closed default). */
    allowOffer?: { ttl_ms: number; max_uses: number };
  } = {},
): Harness => {
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );
  const checkpointStore = createCheckpointStore(createInMemoryCollection<Checkpoint>());
  const subviewStore = makeSubviewStore();
  const submitAnswer = vi.fn(async () => undefined);
  const broadcasts: ReceptionInboxBroadcastEvent[] = [];
  const deps: ReceptionInboxDeps = {
    auditLog,
    checkpointStore,
    resolveArgEditSchema: (opts.resolver ?? resolverStub),
    resolveSource: makeSourceResolver(opts.attachment, opts.topTierKind, opts.sourceKind),
    isReceptionOrigin: defaultIsReceptionOriginAnchor,
    submitAnswer,
    ...(opts.allowOffer !== undefined
      ? { readAskAllowOffer: async () => opts.allowOffer }
      : {}),
    ...(opts.lookupBookingHistory !== undefined
      ? { lookupBookingHistory: opts.lookupBookingHistory }
      : {}),
    ...(opts.resolveFormResponseEdit !== undefined
      ? { resolveFormResponseEdit: opts.resolveFormResponseEdit }
      : {}),
    subviewStore,
    broadcast: (e) => broadcasts.push(e),
    now: () => NOW,
  };
  return { deps, auditLog, checkpointStore, subviewStore, submitAnswer, broadcasts };
};

/** Seed one reception-incoming held op (anchor + checkpoint). */
const seedHeld = async (
  h: Harness,
  anchorOverrides: Partial<AuditEntry> = {},
  checkpointOverrides: Partial<Checkpoint> = {},
): Promise<{ anchor: AuditEntry; checkpoint: Checkpoint }> => {
  const anchor = mkAnchor(anchorOverrides);
  const checkpoint = mkCheckpoint(checkpointOverrides);
  await h.auditLog.append(anchor);
  await h.checkpointStore.write(checkpoint);
  return { anchor, checkpoint };
};

beforeEach(() => {
  resolverStub.mockClear();
});

// ────────────────────────────────────────────────────────────────
// I-2 — held-op query + origin filter (N.1)
// ────────────────────────────────────────────────────────────────

describe('origin filter (N.1)', () => {
  it('default filter: reception reactive trigger is reception-origin', () => {
    expect(defaultIsReceptionOriginAnchor(mkAnchor())).toBe(true);
  });

  it('default filter: reception channel is reception-origin', () => {
    expect(
      defaultIsReceptionOriginAnchor(
        mkAnchor({ execution_source: { channel: 'reception', actor: 'anonymous', reception_id: 'r1' } }),
      ),
    ).toBe(true);
  });

  it('default filter: a non-reception reactive recipe is NOT reception-origin', () => {
    expect(
      defaultIsReceptionOriginAnchor(mkAnchor({ execution_source: nonReceptionSource })),
    ).toBe(false);
  });

  it('default filter: a plain user/chat/mcp gated op is NOT reception-origin', () => {
    expect(
      defaultIsReceptionOriginAnchor(
        mkAnchor({ execution_source: { channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 't', mcp_token_id: 'm', contract_id: 'c' } }),
      ),
    ).toBe(false);
    expect(defaultIsReceptionOriginAnchor(mkAnchor({ execution_source: undefined }))).toBe(false);
  });

  it('list maps held ops → InboxItem and EXCLUDES a non-reception gated op (origin filter)', async () => {
    const h = makeHarness();
    await seedHeld(h);
    // A second awaiting hold from a NON-reception origin — must NOT appear.
    await h.auditLog.append(
      mkAnchor({
        run_id: 'run-evil',
        recipe_id: 'recued-core/detect-deal-risk',
        execution_source: nonReceptionSource,
        ask_id: 'ask-evil',
        checkpoint_id: 'cp-evil',
      }),
    );
    await h.checkpointStore.write(
      mkCheckpoint({ checkpoint_id: 'cp-evil', run_id: 'run-evil', recipe_id: 'recued-core/detect-deal-risk' }),
    );

    const res = await handleReceptionInboxList(h.deps, undefined, ADMIN);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.hold_id).toBe('cp-1');
    expect(res.items[0]!.operation_id).toBe('reception-intake.create_commitment');
    expect(res.items[0]!.arg_schema).toEqual(allowlistSchema);
    // The non-reception hold leaked nowhere.
    expect(res.items.some((i) => i.hold_id === 'cp-evil')).toBe(false);
  });

  it('a store-only FormResponse hold exposes no ineffective entity edits', async () => {
    const h = makeHarness({ topTierKind: 'form_response' });
    await seedHeld(h);

    const res = await handleReceptionInboxList(h.deps, undefined, ADMIN);

    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.top_tier_kind).toBe('form_response');
    expect(res.items[0]!.arg_schema).toEqual({ fields: [] });
    expect(resolverStub).not.toHaveBeenCalled();
  });

  it('prefills only the dedicated form-response working fields on the owner inbox', async () => {
    const resolveFormResponseEdit = vi.fn(async () => ({
      values: { project: 'Original sealed answer' },
      visitor_email: 'visitor@example.test',
    }));
    const h = makeHarness({ topTierKind: 'form_response', resolveFormResponseEdit });
    await seedHeld(h);

    const res = await handleReceptionInboxList(h.deps, undefined, ADMIN);
    expect(resolveFormResponseEdit).toHaveBeenCalledWith(
      expect.objectContaining({ record_ref: 'cp-1' }),
      expect.objectContaining({ title: 'Coffee chat' }),
    );
    expect(res.items[0]?.args).toMatchObject({
      form_response_values: { project: 'Original sealed answer' },
      form_response_visitor_email: 'visitor@example.test',
    });
    expect(res.items[0]?.arg_schema.fields.map((field) => field.key)).toEqual([
      'form_response_values',
      'form_response_visitor_email',
    ]);
  });

  it('passes scheduling projection args to the owner-only history resolver', async () => {
    const lookupBookingHistory = vi.fn(async (_source, args) => {
      // History authority is the substrate-authored reservation id, never a
      // source presentation ref supplied by a caller or test seam.
      expect(args.booking_request_id).toBe('reservation-77');
      return {
        counterparty_contact_id: 'contact-opaque',
        total: 1,
        entries: [{
          id: 'booking-old',
          title: 'Earlier visit',
          lifecycle_state: 'no_show' as const,
          created_at: NOW - 2,
          state_changed_at: NOW - 1,
        }],
      };
    });
    const h = makeHarness({
      topTierKind: 'booking',
      sourceKind: 'scheduling_link',
      lookupBookingHistory,
    });
    await seedHeld(h, {}, {
      step_state: {
        materialize: { input: { booking_request_id: 'reservation-77', title: 'Booking' } },
      },
    });

    const res = await handleReceptionInboxList(h.deps, undefined, ADMIN);
    expect(lookupBookingHistory).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'scheduling_link', record_ref: 'cp-1' }),
      expect.objectContaining({ booking_request_id: 'reservation-77' }),
    );
    expect(res.items[0]?.booking_history).toMatchObject({
      counterparty_contact_id: 'contact-opaque',
      total: 1,
      entries: [{ id: 'booking-old', lifecycle_state: 'no_show' }],
    });
    expect(JSON.stringify(res.items[0]?.booking_history)).not.toContain('@');
  });

  it('queryReceptionInboxHeldOps skips a terminal (succeeded) run and one with no checkpoint', async () => {
    const h = makeHarness();
    await seedHeld(h);
    await h.auditLog.append(mkAnchor({ run_id: 'run-done', commit_status: 'succeeded', checkpoint_id: 'cp-done' }));
    // awaiting but no checkpoint persisted → skipped.
    await h.auditLog.append(mkAnchor({ run_id: 'run-nocp', checkpoint_id: 'cp-missing' }));
    const held = await queryReceptionInboxHeldOps(h.deps);
    expect(held.map((x) => x.checkpoint.checkpoint_id)).toEqual(['cp-1']);
  });
});

// ────────────────────────────────────────────────────────────────
// THE BOUNDARY MUST — only approve writes arg_overrides, allowlist-first
// ────────────────────────────────────────────────────────────────

describe('BOUNDARY MUST (N.5) — checkpoint.arg_overrides write path', () => {
  it('before approve, the checkpoint carries NO arg_overrides', async () => {
    const h = makeHarness();
    const { checkpoint } = await seedHeld(h);
    expect(checkpoint.arg_overrides).toBeUndefined();
    expect((await h.checkpointStore.get('cp-1'))!.arg_overrides).toBeUndefined();
  });

  it('list does NOT write arg_overrides (read-only)', async () => {
    const h = makeHarness();
    await seedHeld(h);
    await handleReceptionInboxList(h.deps, undefined, ADMIN);
    expect((await h.checkpointStore.get('cp-1'))!.arg_overrides).toBeUndefined();
  });

  it('approve WRITES allowlist-validated edits to arg_overrides via the narrow writer', async () => {
    const h = makeHarness();
    await seedHeld(h);
    const res = await handleReceptionInboxApprove(
      h.deps,
      { hold_id: 'cp-1', edits: { start_at: 123, calendar_id: 'cal-b' } },
      ADMIN,
    );
    expect(res.released).toBe(true);
    expect(res.edited_keys.sort()).toEqual(['calendar_id', 'start_at']);
    const cp = await h.checkpointStore.get('cp-1');
    expect(cp!.arg_overrides).toEqual({ start_at: 123, calendar_id: 'cal-b' });
  });

  it('approve REJECTS a non-allowlisted edit key and writes NOTHING to the checkpoint', async () => {
    const h = makeHarness();
    await seedHeld(h);
    // `title` is NOT in the allowlist.
    await expect(
      handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1', edits: { title: 'hacked' } }, ADMIN),
    ).rejects.toMatchObject({ code: 'edit_not_allowed' });
    // The boundary held: arg_overrides was never written, the ask was
    // never answered, no broadcast.
    expect((await h.checkpointStore.get('cp-1'))!.arg_overrides).toBeUndefined();
    expect(h.submitAnswer).not.toHaveBeenCalled();
    expect(h.broadcasts).toHaveLength(0);
  });

  it('approve REJECTS an allowlisted key mixed with a non-allowlisted one (all-or-nothing)', async () => {
    const h = makeHarness();
    await seedHeld(h);
    await expect(
      handleReceptionInboxApprove(
        h.deps,
        { hold_id: 'cp-1', edits: { start_at: 5, title: 'sneak' } },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'edit_not_allowed' });
    expect((await h.checkpointStore.get('cp-1'))!.arg_overrides).toBeUndefined();
  });

  it('validateEditsAgainstSchema rejects a prototype-pollution key even if oddly allowlisted', () => {
    const polluted: ArgEditSchema = { fields: [{ key: '__proto__', type: 'json' }] };
    expect(() =>
      validateEditsAgainstSchema({ ['__proto__']: { polluted: true } }, polluted, 'm'),
    ).toThrow(RpcError);
  });

  it('the narrow setArgOverrides writer fails closed on an unknown checkpoint', async () => {
    const h = makeHarness();
    await expect(
      h.checkpointStore.setArgOverrides('nope', { arg_overrides: { x: 1 } }),
    ).rejects.toThrow(/not found/);
  });
});

// ────────────────────────────────────────────────────────────────
// approved_target recompute (N.5 §3)
// ────────────────────────────────────────────────────────────────

describe('approved_target recompute (N.5 §3)', () => {
  it('a target-affecting edit recomputes approved_target onto the checkpoint', async () => {
    const h = makeHarness();
    await seedHeld(h);
    await handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1', edits: { calendar_id: 'cal-NEW' } }, ADMIN);
    const cp = await h.checkpointStore.get('cp-1');
    // calendar_id is affects_target → connection axis re-resolved to the
    // consciously-chosen destination; the operation identity is preserved.
    expect(cp!.approved_target?.connection_name).toBe('cal-NEW');
    expect(cp!.approved_target?.operation_id).toBe('reception-intake.create_commitment');
  });

  it('a non-target edit leaves approved_target untouched (drift guard intact)', async () => {
    const h = makeHarness();
    await seedHeld(h);
    await handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1', edits: { start_at: 999 } }, ADMIN);
    const cp = await h.checkpointStore.get('cp-1');
    expect(cp!.approved_target?.connection_name).toBe('cal-default');
  });

  it('recomputeApprovedTarget returns undefined when no target field was edited', () => {
    expect(
      recomputeApprovedTarget({ connection_name: 'a' }, { start_at: 1 }, allowlistSchema),
    ).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Release via the EXISTING resume path + audit
// ────────────────────────────────────────────────────────────────

describe("D-177 N.14 — 'Approve & allow for this form'", () => {
  const OFFER = { ttl_ms: 86_400_000, max_uses: 20 };

  it("allow releases through 'allow_session' + audits the allow", async () => {
    const h = makeHarness({ allowOffer: OFFER });
    await seedHeld(h);
    const res = await handleReceptionInboxApprove(
      h.deps,
      { hold_id: 'cp-1', allow: true },
      ADMIN,
    );
    expect(res.released).toBe(true);
    expect(h.submitAnswer).toHaveBeenCalledWith('ask-1', 'allow_session');
    const activity = await h.auditLog.listActivities(10);
    expect(
      activity.some((a) => a.detail?.includes('approved & allowed for this form')),
    ).toBe(true);
  });

  it('allow REFUSES with edits — an edited approval earns no standing trust', async () => {
    const h = makeHarness({ allowOffer: OFFER });
    await seedHeld(h);
    await expect(
      handleReceptionInboxApprove(
        h.deps,
        { hold_id: 'cp-1', allow: true, edits: { start_at: 1 } },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it("allow FAILS CLOSED when the ask carries no offer (submitAnswer would silently no-op an un-offered option)", async () => {
    const h = makeHarness();
    await seedHeld(h);
    await expect(
      handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1', allow: true }, ADMIN),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('the list projects allow_offer off the real ask; absent dep projects none', async () => {
    const withOffer = makeHarness({ allowOffer: OFFER });
    await seedHeld(withOffer);
    const listed = await handleReceptionInboxList(withOffer.deps, undefined, ADMIN);
    expect(listed.items[0]?.allow_offer).toEqual(OFFER);

    const without = makeHarness();
    await seedHeld(without);
    const bare = await handleReceptionInboxList(without.deps, undefined, ADMIN);
    expect(bare.items[0]?.allow_offer).toBeUndefined();
  });

  it('plain approve is untouched by the offer (regression pin)', async () => {
    const h = makeHarness({ allowOffer: OFFER });
    await seedHeld(h);
    await handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1' }, ADMIN);
    expect(h.submitAnswer).toHaveBeenCalledWith('ask-1', 'approve');
  });
});

describe('release + audit', () => {
  it("approve answers the held op's gateway.preflight ask with 'approve'", async () => {
    const h = makeHarness();
    await seedHeld(h);
    await handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1', edits: { start_at: 1 } }, ADMIN);
    expect(h.submitAnswer).toHaveBeenCalledWith('ask-1', 'approve');
    expect(h.broadcasts).toEqual([{ kind: 'reception_inbox', op: 'approved', hold_id: 'cp-1' }]);
  });

  it('approve with NO edits still releases (approve-as-prefilled) + writes empty overrides', async () => {
    const h = makeHarness();
    await seedHeld(h);
    const res = await handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1' }, ADMIN);
    expect(res.released).toBe(true);
    expect(res.edited_keys).toEqual([]);
    expect((await h.checkpointStore.get('cp-1'))!.arg_overrides).toEqual({});
    expect(h.submitAnswer).toHaveBeenCalledWith('ask-1', 'approve');
  });

  it('approve without a release ask fails closed before overrides, audit, or broadcast', async () => {
    const h = makeHarness();
    await seedHeld(h, { ask_id: undefined });

    const res = await handleReceptionInboxApprove(
      h.deps,
      { hold_id: 'cp-1', edits: { start_at: 123 } },
      ADMIN,
    );

    expect(res).toEqual({
      hold_id: 'cp-1',
      released: false,
      reason: 'not_configured',
      edited_keys: [],
    });
    expect((await h.checkpointStore.get('cp-1'))!.arg_overrides).toBeUndefined();
    expect(h.submitAnswer).not.toHaveBeenCalled();
    expect(h.broadcasts).toHaveLength(0);
    const acts = await h.auditLog.listActivities(10);
    expect(acts.some((a) => (a.action as string) === 'reception.inbox.approved')).toBe(false);
  });

  it('approve records a signed "approved with edits" audit row carrying the diff', async () => {
    const h = makeHarness();
    await seedHeld(h);
    await handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1', edits: { calendar_id: 'cal-b' } }, ADMIN);
    const acts = await h.auditLog.listActivities(10);
    const row = acts.find((a) => (a.action as string) === 'reception.inbox.approved');
    expect(row).toBeDefined();
    expect(row!.target).toBe('cp-1');
    expect(row!.detail).toContain('calendar_id');
    expect(row!.reserve).toBe(true);
  });

  it('redacts form-response values and email from the approval audit diff', async () => {
    const h = makeHarness({
      topTierKind: 'form_response',
      resolveFormResponseEdit: async () => ({
        values: { secret: 'original visitor words' },
        visitor_email: 'original@example.test',
      }),
    });
    await seedHeld(h);
    await handleReceptionInboxApprove(h.deps, {
      hold_id: 'cp-1',
      edits: {
        form_response_values: { secret: 'owner corrected words' },
        form_response_visitor_email: 'corrected@example.test',
      },
    }, ADMIN);

    const acts = await h.auditLog.listActivities(10);
    const row = acts.find((entry) => (entry.action as string) === 'reception.inbox.approved');
    expect(row?.detail).toContain('<redacted form response content>');
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('original visitor words');
    expect(serialized).not.toContain('owner corrected words');
    expect(serialized).not.toContain('original@example.test');
    expect(serialized).not.toContain('corrected@example.test');
  });

  it('approve on an unknown / consumed hold → hold_not_found', async () => {
    const h = makeHarness();
    await expect(
      handleReceptionInboxApprove(h.deps, { hold_id: 'gone' }, ADMIN),
    ).rejects.toMatchObject({ code: 'hold_not_found' });
  });
});

// ────────────────────────────────────────────────────────────────
// Attachment scan-gate (N.2 / D-172 Q2)
// ────────────────────────────────────────────────────────────────

describe('attachment scan-gate (N.2)', () => {
  const att = (scan_status: 'pending' | 'clean' | 'flagged' | 'unscanned') => ({
    file_id: 'f1',
    filename: 'doc.pdf',
    mime_type: 'application/pdf',
    size: 1024,
    scan_status,
  });

  it('refuses approve while scan is pending (and writes nothing)', async () => {
    const h = makeHarness({ attachment: att('pending') });
    await seedHeld(h);
    await expect(
      handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1', edits: { start_at: 1 } }, ADMIN),
    ).rejects.toMatchObject({ code: 'attachment_scan_pending' });
    expect((await h.checkpointStore.get('cp-1'))!.arg_overrides).toBeUndefined();
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('refuses an unscanned attachment without acknowledgement; allows with it (advisory)', async () => {
    const h = makeHarness({ attachment: att('unscanned') });
    await seedHeld(h);
    await expect(handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1' }, ADMIN)).rejects.toMatchObject({
      code: 'attachment_unscanned',
    });
    const res = await handleReceptionInboxApprove(
      h.deps,
      { hold_id: 'cp-1', acknowledge_attachment_risk: true },
      ADMIN,
    );
    expect(res.released).toBe(true);
  });

  it('refuses a flagged attachment without acknowledgement; allows with it', async () => {
    const h = makeHarness({ attachment: att('flagged') });
    await seedHeld(h);
    await expect(handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1' }, ADMIN)).rejects.toMatchObject({
      code: 'attachment_flagged',
    });
    const res = await handleReceptionInboxApprove(
      h.deps,
      { hold_id: 'cp-1', acknowledge_attachment_risk: true },
      ADMIN,
    );
    expect(res.released).toBe(true);
  });

  it('a pending scan stays held even WITH acknowledgement (the hold is not acknowledgeable)', async () => {
    const h = makeHarness({ attachment: att('pending') });
    await seedHeld(h);
    await expect(
      handleReceptionInboxApprove(
        h.deps,
        { hold_id: 'cp-1', acknowledge_attachment_risk: true },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'attachment_scan_pending' });
  });

  it('a clean attachment approves normally', async () => {
    const h = makeHarness({ attachment: att('clean') });
    await seedHeld(h);
    const res = await handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1' }, ADMIN);
    expect(res.released).toBe(true);
  });

  it('a pending/flagged attachment surfaces the item as requires_review in list', async () => {
    const h = makeHarness({ attachment: att('pending') });
    await seedHeld(h);
    const res = await handleReceptionInboxList(h.deps, undefined, ADMIN);
    expect(res.items[0]!.status).toBe('requires_review');
    expect(res.items[0]!.attachment?.scan_status).toBe('pending');
  });
});

// ────────────────────────────────────────────────────────────────
// reject → subview (N.2 / D10)
// ────────────────────────────────────────────────────────────────

describe('reject → subview (D10)', () => {
  // NOTE (2026-07-16): this case used to also assert `freeSlotHold` was called
  // once — and it passed, for months, while production froze the slot forever.
  // The production impl was `() => undefined`, so the assertion proved the STUB
  // was invoked, not that anything was freed. A green test reading "frees the
  // slot" is a large part of why that defect (BUG-1) survived unseen. The seam
  // is now deleted with the hold model; there is no slot to free.
  // [[test_real_gate_not_mock_for_admission]] — assert the BEHAVIOUR, never that
  // a seam was called.
  it('reject records a dismissed subview row, answers deny, and NEVER writes arg_overrides', async () => {
    const h = makeHarness();
    await seedHeld(h);
    const res = await handleReceptionInboxReject(h.deps, { hold_id: 'cp-1', reason: 'spam' }, ADMIN);
    expect(res.status).toBe('dismissed');
    expect(h.subviewStore.rows).toHaveLength(1);
    expect(h.subviewStore.rows[0]).toMatchObject({ hold_id: 'cp-1', status: 'dismissed', reason: 'spam' });
    expect(h.submitAnswer).toHaveBeenCalledWith('ask-1', 'deny');
    // reject never writes arg_overrides (only approve does).
    expect((await h.checkpointStore.get('cp-1'))!.arg_overrides).toBeUndefined();
    expect(h.broadcasts).toEqual([{ kind: 'reception_inbox', op: 'rejected', hold_id: 'cp-1' }]);
  });

  it('N.14.8 fork 3 — reject STAMPS the door it was held under, so it is countable against the key the learner suggests for', async () => {
    // §N.14.8 v1 recorded "rejects aren't durably keyed" as the blocker: the row
    // was already durable, it just named no door.
    const h = makeHarness();
    // `seedHeld` already threads anchor overrides — no new harness seam needed.
    await seedHeld(h, {
      execution_source: {
        channel: 'reception',
        actor: 'anonymous',
        reception_id: 'r1',
        contract_id: 'ct_door_a',
      },
    });
    await handleReceptionInboxReject(h.deps, { hold_id: 'cp-1', reason: 'spam' }, ADMIN);
    expect(h.subviewStore.rows[0]!.door_contract_id).toBe('ct_door_a');
  });

  it('N.14.8 fork 3 — a reject on a source carrying NO contract stamps NO door (never a false one)', async () => {
    // The default harness source is `(reactive, system)` — no contract_id. An
    // invented/defaulted door would count this reject against someone.
    const h = makeHarness();
    await seedHeld(h);
    await handleReceptionInboxReject(h.deps, { hold_id: 'cp-1' }, ADMIN);
    expect(h.subviewStore.rows[0]!.door_contract_id).toBeUndefined();
    // ...and it is therefore counted for nobody, not for everybody.
    expect(h.subviewStore.countRejectsForDoor('ct_door_a', 0).count).toBe(0);
  });

  it('N.14.8 fork 3 — the door reject count is windowed, dismissed-only, and per-door', async () => {
    const h = makeHarness();
    const store = h.subviewStore;
    const row = (
      hold_id: string,
      over: Partial<{ status: 'dismissed' | 'expired'; dismissed_at: number; door_contract_id: string }>,
    ) => store.record({
      hold_id,
      status: 'dismissed',
      top_tier_kind: 'commitment',
      source_record_ref: 'rec-1',
      dismissed_at: 1_000,
      door_contract_id: 'ct_door_a',
      ...over,
    });
    row('h1', {});
    row('h2', { dismissed_at: 2_000 });
    row('h3', { dismissed_at: 500 });                       // BEFORE the window
    row('h4', { status: 'expired' });                       // the clock, not the owner
    row('h5', { door_contract_id: 'ct_door_b' });           // another door

    const res = store.countRejectsForDoor('ct_door_a', 1_000);
    expect(res.count).toBe(2);                  // h1 + h2 only
    expect(res.last_rejected_at).toBe(2_000);
    // ⛔ an EXPIRED item is nobody's decision — it must never read as a rejection.
    expect(store.countRejectsForDoor('ct_door_b', 1_000).count).toBe(1);
    expect(store.countRejectsForDoor('ct_unknown', 0).count).toBe(0);
    expect(store.countRejectsForDoor('ct_unknown', 0).last_rejected_at).toBeUndefined();
  });

  it('reject persists the held item top_tier_kind so the subview labels it like the open list (drop → task)', async () => {
    const h = makeHarness({ topTierKind: 'task' });
    await seedHeld(h);
    await handleReceptionInboxReject(h.deps, { hold_id: 'cp-1' }, ADMIN);
    expect(h.subviewStore.rows[0]!.top_tier_kind).toBe('task');
    // surfaced through the subview list (not the generic 'commitment').
    const sub = await handleReceptionInboxList(h.deps, { view: 'subview' }, ADMIN);
    expect(sub.items[0]!.top_tier_kind).toBe('task');
  });

  it('reject still dismisses locally when deny delivery is not configured', async () => {
    const h = makeHarness();
    await seedHeld(h, { ask_id: undefined });
    const res = await handleReceptionInboxReject(h.deps, { hold_id: 'cp-1' }, ADMIN);
    expect(res.status).toBe('dismissed');
    expect(h.subviewStore.rows).toHaveLength(1);
    expect(h.submitAnswer).not.toHaveBeenCalled();
    const acts = await h.auditLog.listActivities(10);
    expect(acts.some((a) => a.detail?.includes('deny not delivered: not_configured') === true)).toBe(true);
  });

  it('reject on unknown hold → hold_not_found', async () => {
    const h = makeHarness();
    await expect(handleReceptionInboxReject(h.deps, { hold_id: 'gone' }, ADMIN)).rejects.toMatchObject({
      code: 'hold_not_found',
    });
  });

  it('list view=subview returns dismissed items (terminal, empty arg_schema)', async () => {
    const h = makeHarness();
    await seedHeld(h);
    await handleReceptionInboxReject(h.deps, { hold_id: 'cp-1', reason: 'no thanks' }, ADMIN);
    const sub = await handleReceptionInboxList(h.deps, { view: 'subview' }, ADMIN);
    expect(sub.items).toHaveLength(1);
    expect(sub.items[0]!.status).toBe('dismissed');
    expect(sub.items[0]!.arg_schema.fields).toEqual([]);
  });

  it('auto_cleanup_days=0 purges the whole subview', async () => {
    const h = makeHarness();
    await seedHeld(h);
    await handleReceptionInboxReject(h.deps, { hold_id: 'cp-1' }, ADMIN);
    // dismissed_at === NOW; cutoff for 0 days is NOW (strictly-older purge),
    // so a row stamped a hair in the past purges. Stamp it older to assert.
    h.subviewStore.rows[0]!.dismissed_at = NOW - 1;
    const purged = purgeReceptionInboxSubview(h.deps, 0);
    expect(purged).toBe(1);
    expect(h.subviewStore.rows).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Admin-only gate
// ────────────────────────────────────────────────────────────────

describe('admin-only gate', () => {
  it('list / approve / reject refuse an unpaired caller', async () => {
    const h = makeHarness();
    await seedHeld(h);
    await expect(handleReceptionInboxList(h.deps, undefined, undefined)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1' }, { instance_id: null })).rejects.toMatchObject({
      code: 'permission_denied',
    });
    await expect(handleReceptionInboxReject(h.deps, { hold_id: 'cp-1' }, undefined)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    // The boundary held even on the unauthorized approve.
    expect((await h.checkpointStore.get('cp-1'))!.arg_overrides).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// I-4 — the "N waiting" ping (D-158)
// ────────────────────────────────────────────────────────────────

describe('inbox ping (I-4)', () => {
  it('raises one ask with the count + an inbox link when ≥1 waiting', async () => {
    const h = makeHarness();
    await seedHeld(h);
    const raise: RaiseInboxPingAsk = vi.fn(async () => ({ ask_id: 'ping-1' }));
    const out = await pingReceptionInbox(h.deps, raise, 'https://x/reception/inbox');
    expect(out).toEqual({ ask_id: 'ping-1' });
    expect(raise).toHaveBeenCalledTimes(1);
    const msg = (raise as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      text: string;
      link_url?: string;
    };
    expect(msg.link_url).toBe('https://x/reception/inbox');
    expect(msg.text).toContain('1 incoming request');
  });

  it('is a no-op when nothing is waiting', async () => {
    const h = makeHarness();
    const raise: RaiseInboxPingAsk = vi.fn(async () => ({ ask_id: 'x' }));
    expect(await pingReceptionInbox(h.deps, raise, 'url')).toBeNull();
    expect(raise).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// Default source resolver (N.1) — redacted, no PII leak
// ────────────────────────────────────────────────────────────────

describe('defaultResolveInboxSource (N.1)', () => {
  it('derives a redacted preview from the checkpoint without leaking sealed PII', () => {
    const anchor = mkAnchor();
    const checkpoint = mkCheckpoint();
    const resolved = defaultResolveInboxSource({ anchor, checkpoint });
    expect(resolved).not.toBeNull();
    // Redacted — a generic title, never the visitor's submitted content.
    expect(resolved!.preview.title).toBe('Incoming request');
    expect(resolved!.args).toEqual({ title: 'Coffee chat', start_at: 0, calendar_id: 'cal-a' });
    expect(resolved!.source.record_ref).toBe('cp-1');
  });

  it('surfaces the real materialize target (top_tier_kind) the drain stamped into the gated args', () => {
    // A drop stamps `top_tier_kind: 'task'`; a scheduling reservation stamps
    // `'booking'`. The inbox list must label WHAT it will
    // materialize into, not a generic `commitment` (which mislabels a
    // file-drop / a booking in the review queue).
    const anchor = mkAnchor();
    for (const kind of ['task', 'booking'] as const) {
      const checkpoint = mkCheckpoint({
        step_state: { materialize: { input: { top_tier_kind: kind, id: 'reception_x', title: 'note.txt' } } },
      });
      const resolved = defaultResolveInboxSource({ anchor, checkpoint });
      expect(resolved!.top_tier_kind).toBe(kind);
    }
  });

  it('recognizes the managed reschedule door as a scheduling-link booking hold', () => {
    // ⛔ THE SHAPE HERE IS PRODUCTION'S, and that is the whole point. This test
    // previously fabricated `gated_step_id: 'materialize'` with
    // `step_state.materialize.input = { top_tier_kind: 'booking', booking_id }`
    // — a shape NOTHING writes on this path — so it passed while the real flow
    // was broken in three ways at once. `reschedule-booking-managed.json` gates
    // on the step `reschedule`, whose op is the KERNEL op
    // `core.work-entity.booking.update`, whose args are `{ id, slot_start_at,
    // slot_end_at }`: no `top_tier_kind`, no `booking_id`.
    // ⇒ [[feedback_a_stub_predecides_the_thing_under_test]]
    const anchor = mkAnchor({
      recipe_id: 'reschedule-booking-managed',
      execution_source: {
        channel: 'reception',
        actor: 'anonymous',
        reception_id: '__manage__',
        contract_id: 'contract-manage',
      },
    });
    const checkpoint = mkCheckpoint({
      recipe_id: 'reschedule-booking-managed',
      gated_step_id: 'reschedule',
      approved_target: {
        ingredient_slug: 'recued/run-ingredient',
        operation_id: 'core.work-entity.booking.update',
        connection_name: '',
      },
      // The shape `reschedule-booking-managed` ACTUALLY produces: the pre-gate
      // transform outputs, PLUS the gated kernel op's resolved input — the
      // engine's simple-form branch now records that on a hold, same as the
      // catalog branch always has.
      step_state: {
        ready: true,
        manage_target_booking_id: 'booking-1',
        reschedule: {
          input: {
            id: 'booking-1',
            slot_start_at: NOW + 60_000,
            slot_end_at: NOW + 120_000,
          },
        },
      },
    });

    const resolved = defaultResolveInboxSource({ anchor, checkpoint });

    expect(resolved).toMatchObject({
      // Not `commitment` — the fallback mislabelled the item AND suppressed the
      // prior-booking history panel, which `projectInboxItem` gates on this.
      top_tier_kind: 'booking',
      // Not the gate checkpoint id.
      source: { kind: 'scheduling_link', record_ref: 'booking-1' },
    });
    expect(resolved!.source.record_ref).not.toBe('cp-1');
    // 🔑 THE PROPOSED NEW TIME reaches the owner. This is the other half of the
    // original complaint — the hold arrived labelled `commitment` with EMPTY
    // args, so the owner was asked to approve a reschedule without being shown
    // the time being proposed. `record_ref` comes from the pre-gate step and
    // the slot comes from the gated step's captured input; the two are
    // complementary, not redundant.
    expect(resolved!.args).toMatchObject({
      slot_start_at: NOW + 60_000,
      slot_end_at: NOW + 120_000,
    });
  });

  it('the managed recipe actually publishes the step the resolver reads', () => {
    // ⛔ THE PAIR IS THE CONTRACT. The resolver reads a step id out of a
    // checkpoint; the recipe is what puts it there. Either alone passes its own
    // test while the flow stays broken — which is exactly how this defect
    // survived: a resolver test fabricated a `step_state` shape no recipe wrote.
    // ⇒ [[feedback_a_call_site_is_not_a_wired_seam]]
    const recipe = JSON.parse(
      readFileSync(
        resolvePath(
          fileURLToPath(import.meta.url),
          '../../../../../community/recipes/reschedule-booking-managed.json',
        ),
        'utf8',
      ),
    ) as { steps: Array<{ id: string; op?: string }> };
    const ids = recipe.steps.map((s) => s.id);
    expect(ids).toContain('manage_target_booking_id');
    // And it must come BEFORE the gated write, or its output is never captured.
    expect(ids.indexOf('manage_target_booking_id'))
      .toBeLessThan(ids.indexOf('reschedule'));
    expect(recipe.steps.find((s) => s.id === 'reschedule')?.op)
      .toBe('core.work-entity.booking.update');
  });

  it('a manage hold whose gated step recorded nothing still degrades honestly', () => {
    // The capture is engine-side; a checkpoint predating it (or any custom hold
    // with no Reception provenance) must fall back to the checkpoint id rather
    // than invent a booking id.
    const anchor = mkAnchor({
      recipe_id: 'reschedule-booking-managed',
      execution_source: {
        channel: 'reception',
        actor: 'anonymous',
        reception_id: '__manage__',
        contract_id: 'contract-manage',
      },
    });
    const resolved = defaultResolveInboxSource({
      anchor,
      checkpoint: mkCheckpoint({ gated_step_id: 'reschedule', step_state: {} }),
    });
    expect(resolved!.source.record_ref).toBe('cp-1');
  });

  it('uses substrate-authored source ids as record_ref and falls back only when absent', () => {
    const cases = [
      {
        anchor: mkAnchor(),
        input: { metadata: { reception_form_submission_id: 'submission-1' } },
        expected: 'submission-1',
      },
      {
        anchor: mkAnchor({
          recipe_id: 'recued-core/reception-scheduling-incoming',
          execution_source: {
            channel: 'reactive',
            actor: 'system',
            event_kind: 'reception.scheduling_link.submitted',
            source_recipe: 'recued-core/reception-scheduling-incoming',
          },
        }),
        input: { booking_request_id: 'request-1' },
        expected: 'request-1',
      },
      {
        anchor: mkAnchor({
          recipe_id: 'recued-core/reception-drop-incoming',
          execution_source: {
            channel: 'reactive',
            actor: 'system',
            event_kind: 'reception.drop_link.submitted',
            source_recipe: 'recued-core/reception-drop-incoming',
          },
        }),
        input: { metadata: { reception_drop_blob_id: 'drop-1' } },
        expected: 'drop-1',
      },
    ] as const;

    for (const testCase of cases) {
      const resolved = defaultResolveInboxSource({
        anchor: testCase.anchor,
        checkpoint: mkCheckpoint({
          step_state: { materialize: { input: testCase.input } },
        }),
      });
      expect(resolved?.source.record_ref).toBe(testCase.expected);
    }
    expect(defaultResolveInboxSource({
      anchor: mkAnchor(),
      checkpoint: mkCheckpoint(),
    })?.source.record_ref).toBe('cp-1');
  });

  it('labels a store-only accepted response honestly', () => {
    const anchor = mkAnchor();
    const checkpoint = mkCheckpoint({
      step_state: {
        materialize: {
          input: {
            top_tier_kind: 'form_response',
            id: 'submission-1',
            title: 'Client intake',
          },
        },
      },
    });

    const resolved = defaultResolveInboxSource({ anchor, checkpoint });

    expect(resolved).toMatchObject({
      top_tier_kind: 'form_response',
      proposed_action: 'Accept and keep this form response in Data',
    });
  });

  it('falls back to commitment when the gated args carry no (or an invalid) top_tier_kind', () => {
    const anchor = mkAnchor();
    // No top_tier_kind in the gated input (the existing intake-shaped checkpoint).
    expect(defaultResolveInboxSource({ anchor, checkpoint: mkCheckpoint() })!.top_tier_kind).toBe('commitment');
    // A junk value is rejected by the closed-set guard → commitment.
    const junk = mkCheckpoint({
      step_state: { materialize: { input: { top_tier_kind: 'not_a_kind', title: 'x' } } },
    });
    expect(defaultResolveInboxSource({ anchor, checkpoint: junk })!.top_tier_kind).toBe('commitment');
  });

  it('surfaces a drop file as the item attachment (file_id + metadata → attachment, unscanned)', () => {
    // D-173 P5 — the drop review payload carries `file_id` + the file metadata
    // under `metadata.reception_*`; the resolver maps them to the InboxItem
    // attachment so the scan gate + inbox warning can act on it. scan_status is
    // `'unscanned'` (no scanner wired yet).
    const anchor = mkAnchor();
    const checkpoint = mkCheckpoint({
      step_state: {
        materialize: {
          input: {
            top_tier_kind: 'task',
            id: 'reception_x',
            title: 'doc.pdf',
            file_id: 'file-123',
            metadata: {
              reception_filename: 'doc.pdf',
              reception_mime_type: 'application/pdf',
              reception_size_bytes: 2048,
            },
          },
        },
      },
    });
    expect(defaultResolveInboxSource({ anchor, checkpoint })!.attachment).toEqual({
      file_id: 'file-123',
      filename: 'doc.pdf',
      mime_type: 'application/pdf',
      size: 2048,
      scan_status: 'unscanned',
    });
  });

  it('omits the attachment for a non-file held op (no file_id)', () => {
    const anchor = mkAnchor();
    expect(defaultResolveInboxSource({ anchor, checkpoint: mkCheckpoint() })!.attachment).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// A held LOOP item — one approval runs every remaining item
// ────────────────────────────────────────────────────────────────

/** The run paused at item `next_index` of a `source_length`-item foreach
 *  over the gated step. Approving runs that item and every one after it, and
 *  the engine applies an approve-time edit to each of them (a corrected
 *  recipient on the held item sends every item there) — so no edits. */
const loopProgress = (
  next_index: number,
  source_length: number,
): NonNullable<Checkpoint['foreach_progress']> => ({
  step_id: 'materialize',
  next_index,
  source_length,
  source_hash: 'a'.repeat(64),
  results: Array.from({ length: next_index }, () => ({ ok: true })),
});

const PREFLIGHT_ASK: PendingAsk = {
  ask_id: 'ask-1',
  message: { title: 'Approve', text: 'Approve?' },
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'deny', label: 'Deny' },
  ],
  handler_kind: 'gateway.preflight',
  handler_payload: { checkpoint_id: 'cp-1' },
  fanout_channels: ['email'],
  status: 'open',
  created_at: NOW,
};

describe('a held loop item — one approval runs every remaining item', () => {
  it('offers no edit fields while items remain after the held one', async () => {
    const h = makeHarness();
    await seedHeld(h, {}, { foreach_progress: loopProgress(0, 3) });
    const res = await handleReceptionInboxList(h.deps, undefined, ADMIN);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.arg_schema.fields).toEqual([]);
    // What it runs is still there to read.
    expect(res.items[0]!.args).toMatchObject({ title: 'Coffee chat', calendar_id: 'cal-a' });
    // …and how many it runs. Nothing listed them, so the items left in the
    // loop are all it can claim: an upper bound.
    expect(res.items[0]!.approval_covers).toEqual({ count: 3, exact: false });
  });

  it('states the count the hold ask states — exact when the gate listed the calls', async () => {
    const listed = (to: string) => ({ summary: `to: ${to}`, args_preview: { to } });
    const cases: Array<[NonNullable<Checkpoint['preflight_context']>, unknown]> = [
      // Four left in the loop, two of them on another account: two are this approval's.
      [{ foreach_cover: { total: 2, items: [listed('dana'), listed('eli')] } }, { count: 2, exact: true }],
      // The gate could not list them: its count is a bound, and says so.
      [{ foreach_cover: { total: 4 } }, { count: 4, exact: false }],
      // Unreadable — read as the ask reads it, so the loop's own count stands.
      [{ foreach_cover: { total: 'many' } as never }, { count: 4, exact: false }],
    ];
    for (const [preflight_context, expected] of cases) {
      const h = makeHarness();
      await seedHeld(h, {}, { foreach_progress: loopProgress(0, 4), preflight_context });
      const res = await handleReceptionInboxList(h.deps, undefined, ADMIN);
      expect(res.items[0]!.approval_covers).toEqual(expected);
    }
  });

  it('refuses an edit — nothing is written and nothing is released', async () => {
    const h = makeHarness();
    await seedHeld(h, {}, { foreach_progress: loopProgress(0, 3) });
    await expect(
      handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1', edits: { calendar_id: 'cal-b' } }, ADMIN),
    ).rejects.toMatchObject({ code: 'edit_not_allowed' });
    expect((await h.checkpointStore.get('cp-1'))!.arg_overrides).toBeUndefined();
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('still approves as it stands', async () => {
    const h = makeHarness();
    await seedHeld(h, {}, { foreach_progress: loopProgress(0, 3) });
    const res = await handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1' }, ADMIN);
    expect(res.released).toBe(true);
    expect(h.submitAnswer).toHaveBeenCalledWith('ask-1', 'approve');
  });

  it('keeps the fields and states no count when the approval runs one item', async () => {
    // The last item of a loop, a chunked gate, or no loop at all: the
    // approval — and an edit — reaches that one item only.
    const oneItemHolds: Array<Partial<Checkpoint>> = [
      { foreach_progress: loopProgress(2, 3) },
      {
        foreach_progress: loopProgress(0, 3),
        preflight_context: { egress_bound: { requests: 1, total_bytes: 1024 } },
      },
    ];
    for (const overrides of [...oneItemHolds, {}]) {
      const h = makeHarness();
      await seedHeld(h, {}, overrides);
      const res = await handleReceptionInboxList(h.deps, undefined, ADMIN);
      expect(res.items[0]!.arg_schema).toEqual(allowlistSchema);
      expect(res.items[0]).not.toHaveProperty('approval_covers');
    }
  });

  it('a form response held in a loop offers none either', async () => {
    const resolveFormResponseEdit = vi.fn(async () => ({
      values: { project: 'Original sealed answer' },
      visitor_email: 'visitor@example.test',
    }));
    const h = makeHarness({ topTierKind: 'form_response', resolveFormResponseEdit });
    await seedHeld(h, {}, { foreach_progress: loopProgress(0, 3) });
    const res = await handleReceptionInboxList(h.deps, undefined, ADMIN);
    expect(res.items[0]!.arg_schema.fields).toEqual([]);
    expect(res.items[0]!.args).not.toHaveProperty('form_response_values');
  });

  it('the /ask page shows no fields for it and refuses an edit sent anyway', async () => {
    const askPage = (h: Harness) => {
      const findHoldItem = (hold_id: string) => findReceptionHoldItem(h.deps, hold_id);
      const approve = vi.fn(async ({ hold_id, edits, ask_id }: {
        hold_id: string;
        edits: Record<string, unknown>;
        ask_id: string;
      }) => handleReceptionInboxApprove(h.deps, { hold_id, edits }, { ask_landing: { ask_id } }));
      return {
        approve,
        resolveDetails: createAskLandingDetailResolver({ findHoldItem, editable: true, timeZone: 'UTC' }),
        submitEdited: createAskLandingEditApproval({ findHoldItem, approve, timeZone: 'UTC' }),
      };
    };

    // The same hold without the loop renders its editable rows…
    const plain = makeHarness();
    await seedHeld(plain);
    const plainPage = askPage(plain);
    expect((await plainPage.resolveDetails(PREFLIGHT_ASK))!.details.map((d) => d.label)).toEqual([
      'Start',
      'Calendar',
    ]);

    // …held at item 1 of 3 it renders none, and a posted edit is refused
    // before anything is written or released.
    const loop = makeHarness();
    await seedHeld(loop, {}, { foreach_progress: loopProgress(0, 3) });
    const loopPage = askPage(loop);
    expect(await loopPage.resolveDetails(PREFLIGHT_ASK)).toBeNull();
    const out = await loopPage.submitEdited({
      ask: PREFLIGHT_ASK,
      option: 'approve',
      rawEdits: { calendar_id: 'cal-b' },
    });
    expect(out.ok).toBe(false);
    expect(loopPage.approve).not.toHaveBeenCalled();
    expect((await loop.checkpointStore.get('cp-1'))!.arg_overrides).toBeUndefined();
    expect(loop.submitAnswer).not.toHaveBeenCalled();
  });
});
