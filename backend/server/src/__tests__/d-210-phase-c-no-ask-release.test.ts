/** D-210 Phase C — releasing a hold that carries NO durable ask (Option 1).
 *
 *  `inbox_fanout_mode: 'notify'` raises no ask, so the inbox cannot release
 *  by answering one. `createNoAskRelease` drives the decorated
 *  `PreflightResumer` directly instead.
 *
 *  ⛔ THE LANDMINE THIS SUITE EXISTS FOR — `approved_at`.
 *  `PreflightAskContext.approved_at` normally comes from the durable ask's
 *  ANSWER. A no-ask release has no answer, and the intake acceptance hook
 *  fails closed without it. The check sits BEFORE that hook's unpaired
 *  early-return, so an unsupplied timestamp does not merely break D-200
 *  paid intakes — it throws for EVERY reviewed intake, at the promotion
 *  hook, i.e. after the owner clicked approve.
 *
 *  So the central test here drives the REAL promotion hook through the REAL
 *  release path over a REAL submission row + audit anchor. A test that only
 *  asserted "resumeRun was called" would pass just as happily while every
 *  intake approval threw in production. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Checkpoint } from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import type { PreflightAskContext, PreflightResumer } from '@recued/gateway';

import {
  buildNoAskReleaseContext,
  createNoAskRelease,
} from '../reception-inbox-no-ask-release.js';
import {
  handleReceptionInboxApprove,
  handleReceptionInboxReject,
  type ReceptionInboxDeps,
} from '../reception-inbox-handler.js';
import { withBeforePreflightResume } from '../composition/bin/wire-notification-block.js';
import { createFormResponsePromotion } from '../ports/reception/form-response-promotion.js';
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  sealFormSubmissionField,
} from '../ports/reception/form-pii.js';
import { createFormResponseStore } from '../storage/form-response-store.js';
import {
  createReceptionFormSubmissionStore,
  type FormSubmissionStore,
} from '../storage/reception-form-store.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';

const SUBMITTED_AT = 1_700_000_000_000;
const RELEASED_AT = SUBMITTED_AT + 9_000;
const FORM_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x52));
const INTAKE_RECIPE =
  'recued-core/reception-intake-review-then-approve-intake-materialize-1';

const DEFINITION = {
  form_definition_id: 'form-1',
  fields: [{ name: 'project', label: 'Project', type: 'text', required: true }],
};

/** An anchor with NO `ask_id` — exactly what a notify-mode hold leaves
 *  behind, and what a raise-failed accident leaves behind today. */
const askLessIntakeAnchor = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: 'run-intake-1',
  recipe_id: INTAKE_RECIPE,
  recipe_hash: 'hash-1',
  started_at: SUBMITTED_AT,
  finished_at: SUBMITTED_AT,
  duration_ms: 0,
  commit_status: 'awaiting_approval',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: 'reactive',
  instance_id: null,
  execution_source: {
    channel: 'reactive',
    actor: 'system',
    event_kind: 'composition.reception_form_submission',
    source_recipe: INTAKE_RECIPE,
  },
  checkpoint_id: 'cp-1',
  ...overrides,
});

const intakeCheckpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'cp-1',
  run_id: 'run-intake-1',
  recipe_id: INTAKE_RECIPE,
  gated_step_id: 'approved_operation',
  step_state: {
    approved_operation: {
      input: {
        top_tier_kind: 'form_response',
        id: 'sub-1',
        title: 'Reduced projection title',
        metadata: {
          reception_form_submission_id: 'sub-1',
          reception_endpoint_id: 'ep-1',
          form_definition_id: 'form-1',
        },
      },
    },
  },
  created_at: SUBMITTED_AT,
  ...overrides,
});

// ══════════════════════════════════════════════════════════════════
// buildNoAskReleaseContext — the context rebuild
// ══════════════════════════════════════════════════════════════════

describe('D-210 Phase C — buildNoAskReleaseContext', () => {
  it('rebuilds the recipe-bound pair off the checkpoint', () => {
    const ctx = buildNoAskReleaseContext(intakeCheckpoint());
    expect(ctx).toEqual({
      recipe_id: INTAKE_RECIPE,
      gated_step_id: 'approved_operation',
    });
  });

  it('partitions onto the raw-op discriminant, carrying NO recipe fields', () => {
    const ctx = buildNoAskReleaseContext(
      intakeCheckpoint({
        recipe_id: undefined,
        gated_step_id: undefined,
        raw_op: {
          op_id: 'op-77',
          catalog_slug: 'recued-core/mail',
          operation: 'core.mail.send',
          connection_name: 'personal',
          op_args: {},
          execution_source: { channel: 'mcp', actor: 'contracted_user' },
          risk_tier: 'write',
        },
      } as Partial<Checkpoint>),
    );
    expect(ctx).toEqual({ raw_op: { op_id: 'op-77' } });
    // A raw-op context must not smuggle recipe keys — the resumer partitions
    // on exactly this and would take the wrong leg.
    expect(Object.hasOwn(ctx, 'recipe_id')).toBe(false);
    expect(Object.hasOwn(ctx, 'gated_step_id')).toBe(false);
  });

  it('omits absent keys rather than writing `undefined` values', () => {
    const ctx = buildNoAskReleaseContext(
      intakeCheckpoint({ gated_step_id: undefined } as Partial<Checkpoint>),
    );
    // `toMatchObject` cannot prove absence — an explicit `key: undefined`
    // would satisfy it while serializing differently downstream.
    expect(Object.hasOwn(ctx, 'gated_step_id')).toBe(false);
    expect(Object.hasOwn(ctx, 'recipe_id')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// createNoAskRelease — resume/deny + consume ordering
// ══════════════════════════════════════════════════════════════════

describe('D-210 Phase C — createNoAskRelease', () => {
  const recordingResumer = () => {
    const calls: Array<{ leg: string; context: PreflightAskContext }> = [];
    const resumer: PreflightResumer = {
      resumeRun: async (_cp, context) => {
        calls.push({ leg: 'resume', context });
      },
      denyRun: async (_cp, context) => {
        calls.push({ leg: 'deny', context });
      },
    };
    return { resumer, calls };
  };

  it('approve drives resumeRun carrying the supplied approval moment', async () => {
    const { resumer, calls } = recordingResumer();
    const deleted: string[] = [];
    const release = createNoAskRelease({
      resumer,
      checkpointStore: { delete: async (id: string) => { deleted.push(id); } },
    });

    await release(intakeCheckpoint(), { kind: 'approve', approved_at: RELEASED_AT });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.leg).toBe('resume');
    expect(calls[0]?.context.approved_at).toBe(RELEASED_AT);
    expect(calls[0]?.context.recipe_id).toBe(INTAKE_RECIPE);
    expect(deleted).toEqual(['cp-1']);
  });

  it('deny drives denyRun and carries NO approval timestamp', async () => {
    const { resumer, calls } = recordingResumer();
    const deleted: string[] = [];
    const release = createNoAskRelease({
      resumer,
      checkpointStore: { delete: async (id: string) => { deleted.push(id); } },
    });

    await release(intakeCheckpoint(), { kind: 'deny' });

    expect(calls[0]?.leg).toBe('deny');
    expect(Object.hasOwn(calls[0]!.context, 'approved_at')).toBe(false);
    expect(deleted).toEqual(['cp-1']);
  });

  it('CONSUMES the checkpoint only AFTER the resume settles', async () => {
    // Ordering is the crash-safety contract: a delete that raced ahead of a
    // failing resume would drop the hold entirely, with nothing left for the
    // boot sweep to retry.
    const order: string[] = [];
    const release = createNoAskRelease({
      resumer: {
        resumeRun: async () => {
          await Promise.resolve();
          order.push('resume');
        },
        denyRun: async () => { order.push('deny'); },
      },
      checkpointStore: { delete: async () => { order.push('delete'); } },
    });

    await release(intakeCheckpoint(), { kind: 'approve', approved_at: RELEASED_AT });

    expect(order).toEqual(['resume', 'delete']);
  });

  it('does NOT consume the checkpoint when the resume throws', async () => {
    const deleted: string[] = [];
    const release = createNoAskRelease({
      resumer: {
        resumeRun: async () => { throw new Error('executeDeps not yet published'); },
        denyRun: async () => {},
      },
      checkpointStore: { delete: async (id: string) => { deleted.push(id); } },
    });

    await expect(
      release(intakeCheckpoint(), { kind: 'approve', approved_at: RELEASED_AT }),
    ).rejects.toThrow(/executeDeps/);
    // The hold survives for the boot sweep — losing it would strand the
    // visitor's submission with no way back.
    expect(deleted).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// THE LANDMINE — the real promotion hook on the real release path
// ══════════════════════════════════════════════════════════════════

describe('D-210 Phase C — a no-ask release satisfies the intake acceptance hook', () => {
  let db: Database.Database;
  let submissionStore: FormSubmissionStore;
  let responseStore: ReturnType<typeof createFormResponseStore>;
  let auditLog: ReturnType<typeof createAuditLogStore>;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureReceptionSchema(db);
    submissionStore = createReceptionFormSubmissionStore(db);
    responseStore = createFormResponseStore(db);
    auditLog = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );
  });

  afterEach(() => db.close());

  const seedSubmission = async (): Promise<void> => {
    const payload = JSON.stringify({
      visitor_email: 'visitor@example.test',
      fields: { project: 'Northwind' },
    });
    const [visitor, blob] = await Promise.all([
      sealFormSubmissionField({
        key: FORM_KEY,
        endpoint_id: 'ep-1',
        submission_id: 'sub-1',
        field: 'visitor_email',
        plaintext: 'visitor@example.test',
      }),
      sealFormSubmissionField({
        key: FORM_KEY,
        endpoint_id: 'ep-1',
        submission_id: 'sub-1',
        field: 'submission_blob',
        plaintext: payload,
      }),
    ]);
    submissionStore.insert({
      submission_id: 'sub-1',
      endpoint_id: 'ep-1',
      form_definition_id: 'form-1',
      submitted_at: SUBMITTED_AT,
      source_ip_hash: null,
      visitor_email_encrypted: visitor,
      submission_blob_encrypted: blob!,
      schema_version: 1,
      processing_outcome: 'processed',
      metadata: { definition_snapshot: DEFINITION, template_ref: 'intake-template-v1' },
    });
  };

  /** The production decoration: the acceptance hook wrapped around the
   *  resumer, exactly as `composeNotificationBlock` builds it. */
  const decoratedResumer = (inner: PreflightResumer): PreflightResumer =>
    withBeforePreflightResume(
      inner,
      createFormResponsePromotion({
        auditLog,
        submissionStore,
        formResponseStore: responseStore,
        getFormSubmissionPiiKey: () => FORM_KEY,
      }),
    );

  it('releases a reviewed intake WITHOUT throwing at the acceptance hook', async () => {
    await seedSubmission();
    await auditLog.append(askLessIntakeAnchor());
    const resumed = vi.fn(async () => {});
    const release = createNoAskRelease({
      resumer: decoratedResumer({ resumeRun: resumed, denyRun: async () => {} }),
      checkpointStore: { delete: async () => {} },
    });

    // The whole point: this resolves. Before the synthesized `approved_at`
    // it threw `… has no valid durable approval timestamp` — AFTER the owner
    // had already clicked approve.
    await expect(
      release(intakeCheckpoint(), { kind: 'approve', approved_at: RELEASED_AT }),
    ).resolves.toBeUndefined();

    // And the resume actually happened — the hook did not swallow it.
    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it('MUTATION GUARD — dropping approved_at throws at the acceptance hook', async () => {
    // Pins the landmine itself rather than trusting the comment: this is the
    // exact failure a release path that forgot to synthesize the timestamp
    // produces, and it is why the parameter is required.
    await seedSubmission();
    await auditLog.append(askLessIntakeAnchor());
    const promote = createFormResponsePromotion({
      auditLog,
      submissionStore,
      formResponseStore: responseStore,
      getFormSubmissionPiiKey: () => FORM_KEY,
    });

    await expect(
      promote(intakeCheckpoint(), buildNoAskReleaseContext(intakeCheckpoint())),
    ).rejects.toThrow(/no valid durable approval timestamp/);
  });

  it('an UNPAIRED intake is not double-logged by the release (WS2 wrote it at submit)', async () => {
    await seedSubmission();
    await auditLog.append(askLessIntakeAnchor());
    const release = createNoAskRelease({
      resumer: decoratedResumer({ resumeRun: async () => {}, denyRun: async () => {} }),
      checkpointStore: { delete: async () => {} },
    });

    await release(intakeCheckpoint(), { kind: 'approve', approved_at: RELEASED_AT });

    // WS2 moved the canonical log to submit time; the approve leg writes for
    // a D-200 pair only. A no-ask release must not resurrect the old
    // approve-time write.
    expect(responseStore.list()).toEqual([]);
  });

  it('the DENY leg never runs the acceptance hook', async () => {
    await seedSubmission();
    await auditLog.append(askLessIntakeAnchor());
    const denied = vi.fn(async () => {});
    const release = createNoAskRelease({
      resumer: decoratedResumer({ resumeRun: async () => {}, denyRun: denied }),
      checkpointStore: { delete: async () => {} },
    });

    await release(intakeCheckpoint(), { kind: 'deny' });

    expect(denied).toHaveBeenCalledTimes(1);
    expect(responseStore.list()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// The rpcs — approve / reject actually TAKE the no-ask leg
// ══════════════════════════════════════════════════════════════════

describe('D-210 Phase C — inbox approve/reject on an ask-less hold', () => {
  const HOLD = 'cp-1';
  const ADMIN = { instance_id: 'inst-admin' };

  /** Minimal deps over in-memory stores. `releaseWithoutAsk` /
   *  `submitAnswer` are supplied per-test so each leg's presence is the
   *  variable under test. */
  const buildDeps = (over: Partial<ReceptionInboxDeps> = {}): {
    deps: ReceptionInboxDeps;
    released: Array<{ kind: string; approved_at?: number }>;
    answered: Array<{ ask_id: string; option: string }>;
  } => {
    const released: Array<{ kind: string; approved_at?: number }> = [];
    const answered: Array<{ ask_id: string; option: string }> = [];
    const checkpoint = intakeCheckpoint();
    const anchor = askLessIntakeAnchor();
    const deps: ReceptionInboxDeps = {
      auditLog: {
        get: async (run_id: string) => (run_id === anchor.run_id ? anchor : null),
        logActivity: async () => {},
        append: async () => {},
      } as unknown as ReceptionInboxDeps['auditLog'],
      checkpointStore: {
        get: async (id: string) => (id === HOLD ? checkpoint : null),
        setArgOverrides: async () => {},
        delete: async () => {},
      } as unknown as ReceptionInboxDeps['checkpointStore'],
      resolveArgEditSchema: () => ({ operation_id: 'op', fields: [] }),
      resolveSource: () => ({
        top_tier_kind: 'form_response',
        source: { kind: 'intake_form', record_ref: 'sub-1' },
        args: {},
        preview: { title: 'Incoming intake' },
        proposed_action: 'Log the response',
      }),
      isReceptionOrigin: () => true,
      subviewStore: {
        record: () => {},
        purgeOlderThan: () => 0,
        list: () => [],
      } as unknown as ReceptionInboxDeps['subviewStore'],
      broadcast: () => {},
      now: () => RELEASED_AT,
      releaseWithoutAsk: async (_cp, decision) => {
        released.push(
          decision.kind === 'approve'
            ? { kind: 'approve', approved_at: decision.approved_at }
            : { kind: 'deny' },
        );
      },
      ...over,
    };
    return { deps, released, answered };
  };

  it('approve releases through the no-ask leg, stamping the handler clock', async () => {
    const { deps, released } = buildDeps();
    const result = await handleReceptionInboxApprove(deps, { hold_id: HOLD }, ADMIN);

    expect(result.released).toBe(true);
    expect(released).toEqual([{ kind: 'approve', approved_at: RELEASED_AT }]);
  });

  it('reject releases through the no-ask leg (the run must not stay awaiting forever)', async () => {
    const { deps, released } = buildDeps();
    const result = await handleReceptionInboxReject(deps, { hold_id: HOLD }, ADMIN);

    expect(result.status).toBe('dismissed');
    expect(released).toEqual([{ kind: 'deny' }]);
  });

  it('fails closed with not_configured when NEITHER leg is wired', async () => {
    const { deps } = buildDeps({ releaseWithoutAsk: undefined });
    const result = await handleReceptionInboxApprove(deps, { hold_id: HOLD }, ADMIN);

    // Never report a release that did not happen.
    expect(result.released).toBe(false);
    expect(result.reason).toBe('not_configured');
  });

  it('REFUSES `allow` on an ask-less hold — there is no offer to accept', async () => {
    // A session grant mints from the bounds the ask OFFERED. With no ask the
    // owner was shown nothing, so there is nothing to widen against; inventing
    // default bounds would grant standing trust the owner never saw.
    const { deps, released } = buildDeps();
    await expect(
      handleReceptionInboxApprove(deps, { hold_id: HOLD, allow: true }, ADMIN),
    ).rejects.toThrow(/no ask/i);
    expect(released).toEqual([]);
  });
});
