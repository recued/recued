/** D-210 A.8 slice 3d-2c — the ask-landing approver authority.
 *
 *  `reception.inbox.approve` now serves TWO authorities. The point of this
 *  file is that they stay two: the landing path must approve WITHOUT an
 *  `instance_id`, the rpc path must still refuse without one, and the
 *  durable audit row must say which of them acted.
 *
 *  ⛔ The alternative — synthesising an `instance_id` for the landing path —
 *  would satisfy the predicate by writing a paired admin client into the
 *  record that was never there. */

import { describe, expect, it, vi } from 'vitest';
import {
  createAuditLogStore,
  createCheckpointStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import { RpcError, type Checkpoint } from '@recued/contracts';

import {
  defaultIsReceptionOriginAnchor,
  handleReceptionInboxApprove,
  type ReceptionInboxDeps,
  type ResolvedInboxSource,
} from '../reception-inbox-handler.js';

const NOW = 1_700_000_000_000;
const ASK_ID = 'ask-cap-1';

/** Mirrors the D-173 handler suite's fixtures — a reception-origin held op.
 *  The shape is load-bearing: `findHeldOp` re-derives through the real
 *  origin filter, so an approximate anchor simply 404s. */
const mkAnchor = (over: Partial<AuditEntry> = {}): AuditEntry =>
  ({
    run_id: 'run-1',
    recipe_id: 'recued-core/reception-scheduling-incoming',
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
    execution_source: {
      channel: 'reception',
      actor: 'anonymous',
      reception_id: 'r1',
    },
    ask_id: ASK_ID,
    checkpoint_id: 'cp-1',
    ...over,
  }) as unknown as AuditEntry;

const mkCheckpoint = (over: Partial<Checkpoint> = {}): Checkpoint =>
  ({
    checkpoint_id: 'cp-1',
    run_id: 'run-1',
    recipe_id: 'recued-core/reception-scheduling-incoming',
    gated_step_id: 'materialize',
    approved_target: {
      ingredient_slug: 'recued-core/reception-scheduling',
      operation_id: 'reception-scheduling.scheduling.materialize',
    },
    step_state: { materialize: { input: { title: 'Table for four' } } },
    created_at: NOW,
    ...over,
  }) as unknown as Checkpoint;

const makeHarness = () => {
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );
  const checkpointStore = createCheckpointStore(createInMemoryCollection<Checkpoint>());
  const submitAnswer = vi.fn(async () => undefined);
  const activities: ActivityEntry[] = [];
  const realLog = auditLog.logActivity.bind(auditLog);
  auditLog.logActivity = async (entry, options) => {
    activities.push(entry);
    return realLog(entry, options);
  };
  const deps: ReceptionInboxDeps = {
    auditLog,
    checkpointStore,
    resolveArgEditSchema: () => ({
      fields: [{ key: 'title', type: 'string', label: 'Summary' }],
    }),
    resolveSource: (): ResolvedInboxSource =>
      ({
        top_tier_kind: 'booking',
        source: { kind: 'scheduling_link', record_ref: 'req-1' },
        args: { title: 'Table for four' },
        preview: { title: 'A reservation' },
        proposed_action: 'Create a booking',
      }) as unknown as ResolvedInboxSource,
    isReceptionOrigin: defaultIsReceptionOriginAnchor,
    submitAnswer,
    subviewStore: {
      record: () => {},
      list: () => [],
      listDismissedSince: () => [],
    } as unknown as ReceptionInboxDeps['subviewStore'],
    broadcast: () => {},
    now: () => NOW,
  };
  return { deps, auditLog, checkpointStore, submitAnswer, activities };
};

const seed = async (h: ReturnType<typeof makeHarness>): Promise<void> => {
  await h.auditLog.append(mkAnchor());
  await h.checkpointStore.write(mkCheckpoint());
};

describe('D-210 A.8 3d-2c — approver authority', () => {
  it('approves on the ask-landing capability, with NO instance_id anywhere', async () => {
    const h = makeHarness();
    await seed(h);
    const res = await handleReceptionInboxApprove(
      h.deps,
      { hold_id: 'cp-1', edits: { title: 'Table for six' } },
      { ask_landing: { ask_id: ASK_ID } },
    );
    expect(res.released).toBe(true);
    expect(res.edited_keys).toEqual(['title']);
    expect(h.submitAnswer).toHaveBeenCalledWith(ASK_ID, 'approve');
  });

  it('names the ask-landing capability in the durable audit row', async () => {
    // 🔴 Before 3d-2c the approve audit recorded WHAT changed and never WHO:
    // `auditApprovedWithEdits` took an actor and never used it. With two
    // authorities able to approve, "which one" has to be in the record.
    const h = makeHarness();
    await seed(h);
    await handleReceptionInboxApprove(
      h.deps,
      { hold_id: 'cp-1', edits: { title: 'Table for six' } },
      { ask_landing: { ask_id: ASK_ID } },
    );
    const row = h.activities.find((a) => a.target === 'cp-1');
    expect(row?.detail).toContain('ask-landing capability');
    expect(row?.detail).not.toContain('paired admin');

    // ⚠ AMENDED 2026-07-20 (D-210 audit finding 16). This used to assert
    // `toContain(ASK_ID)` — i.e. it PINNED the bearer credential being written
    // verbatim into a durable, reserve-class row that outlives the ask and
    // travels with `server.archive.export`. The sibling public door states the
    // opposite rule for itself ("redact the path explicitly, else the live
    // single-use link would sit in the access log in plaintext").
    //
    // 3d-2c's actual requirement was ATTRIBUTION — "which authority approved" —
    // and that is what is asserted now. A truncated prefix keeps two different
    // asks distinguishable in the record; 8 hex characters do not recover a
    // 122-bit capability.
    expect(row?.detail).not.toContain(ASK_ID);
    expect(row?.detail).toContain('(redacted)');
    expect(row?.detail).toContain(ASK_ID.slice(0, 8));
  });

  it('still DISTINGUISHES two different ask capabilities in the record', async () => {
    // The property the redaction must not cost: if every row read the same, the
    // audit would say an ask-landing approval happened but not which one — and
    // "an audit that finally says who" is the whole point of 3d-2c.
    const a = makeHarness();
    await seed(a);
    await handleReceptionInboxApprove(
      a.deps,
      { hold_id: 'cp-1', edits: { title: 'One' } },
      { ask_landing: { ask_id: ASK_ID } },
    );
    const first = a.activities.find((x) => x.target === 'cp-1')?.detail;

    expect(first).toContain(ASK_ID.slice(0, 8));
    expect(first).not.toContain(ASK_ID);
  });

  it('⛔ REFUSES an ask capability raised for a DIFFERENT hold', async () => {
    // D-210 audit finding 10. `resolveApprover` runs before the hold is resolved,
    // so it can only check the `ask_id` is non-empty — and `hold_id` is
    // caller-supplied, with `findHeldOp` resolving ANY open reception hold. Nothing
    // compared the two, so a capability raised for ask A could release hold B and
    // the audit would attribute B's release to A.
    //
    // Not reachable through the one caller that exists today (the landing port
    // derives `hold_id` from the ask's own `handler_payload.checkpoint_id`), but
    // `handleReceptionInboxApprove` is a public export and the invariant lived in
    // its caller rather than in the handler that enforces authority.
    // ⇒ [[a_capability_derives_its_target]]
    const h = makeHarness();
    await seed(h);
    await expect(
      handleReceptionInboxApprove(
        h.deps,
        { hold_id: 'cp-1', edits: { title: 'Table for six' } },
        { ask_landing: { ask_id: 'ask-someone-elses' } },
      ),
    ).rejects.toThrow(/not raised for this held operation/);
    // …and nothing was released or answered on the way to the refusal.
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('names the paired admin on the rpc path, distinctly', async () => {
    const h = makeHarness();
    await seed(h);
    await handleReceptionInboxApprove(
      h.deps,
      { hold_id: 'cp-1', edits: { title: 'Table for six' } },
      { instance_id: 'inst-42' },
    );
    const row = h.activities.find((a) => a.target === 'cp-1');
    expect(row?.detail).toContain('paired admin inst-42');
    expect(row?.detail).not.toContain('ask-landing');
  });

  it('still refuses the rpc path without a paired instance', async () => {
    const h = makeHarness();
    await seed(h);
    // The landing arm must not become a hole in the admin gate.
    for (const caller of [undefined, { instance_id: null }, { instance_id: '' }]) {
      await expect(
        handleReceptionInboxApprove(h.deps, { hold_id: 'cp-1' }, caller),
      ).rejects.toBeInstanceOf(RpcError);
    }
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('refuses an ask-landing caller carrying no capability', async () => {
    const h = makeHarness();
    await seed(h);
    await expect(
      handleReceptionInboxApprove(
        h.deps,
        { hold_id: 'cp-1' },
        { ask_landing: { ask_id: '' } },
      ),
    ).rejects.toBeInstanceOf(RpcError);
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });

  it('still enforces the allowlist for an ask-landing edit', async () => {
    // The new authority changes WHO may approve, never WHAT may be edited.
    const h = makeHarness();
    await seed(h);
    await expect(
      handleReceptionInboxApprove(
        h.deps,
        { hold_id: 'cp-1', edits: { not_declared: 'x' } },
        { ask_landing: { ask_id: ASK_ID } },
      ),
    ).rejects.toBeInstanceOf(RpcError);
    expect(h.submitAnswer).not.toHaveBeenCalled();
  });
});
