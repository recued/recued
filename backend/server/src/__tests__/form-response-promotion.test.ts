import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FORM_RESPONSE_CREATED_EVENT_PATTERN,
  type Checkpoint,
  type ReceptionFormPairBinding,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';

import { emitFormResponseCreatedEvents } from '../form-response-events.js';
import {
  createFormResponsePromotion,
  FormResponsePromotionError,
} from '../ports/reception/form-response-promotion.js';
import {
  runReceptionProjection,
  type ReceptionProjectionInput,
} from '../ports/reception/projection/reception-projection.js';
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
const ACCEPTED_AT = SUBMITTED_AT + 5_000;
const FORM_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x52));
const DIRECT_PAIR: ReceptionFormPairBinding = {
  version: 1,
  form_definition_id: 'form-1',
  recipe_id: 'direct-document-checkout',
  recipe_version: 3,
  pair_revision: `d200-pair-v1-${'a'.repeat(64)}`,
};

const DEFINITION = {
  form_definition_id: 'form-1',
  fields: [
    { name: 'project', label: 'Project', type: 'text', required: true },
    { name: 'budget', label: 'Budget', type: 'number' },
  ],
};

const intakeAnchor = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: 'run-intake-1',
  recipe_id: 'recued-core/reception-intake-review-then-approve-intake-materialize-1',
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
    source_recipe: 'recued-core/reception-intake-review-then-approve-intake-materialize-1',
  },
  ask_id: 'ask-1',
  checkpoint_id: 'cp-1',
  ...overrides,
});

const intakeCheckpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'cp-1',
  run_id: 'run-intake-1',
  recipe_id: 'recued-core/reception-intake-review-then-approve-intake-materialize-1',
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

describe('owner-approved intake form response promotion', () => {
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

  const seedSubmission = async (options: {
    metadata?: Record<string, unknown>;
    payloadEmail?: string;
    separatelySealedEmail?: string | null;
    directPair?: ReceptionFormPairBinding;
  } = {}): Promise<void> => {
    const payloadEmail = options.payloadEmail ?? 'visitor@example.test';
    const separatelySealedEmail = options.separatelySealedEmail === undefined
      ? payloadEmail
      : options.separatelySealedEmail;
    const payload = JSON.stringify({
      ...(payloadEmail.length > 0 ? { visitor_email: payloadEmail } : {}),
      fields: { project: 'Northwind', budget: 2500 },
    });
    const [visitor, blob] = await Promise.all([
      sealFormSubmissionField({
        key: FORM_KEY,
        endpoint_id: 'ep-1',
        submission_id: 'sub-1',
        field: 'visitor_email',
        plaintext: separatelySealedEmail,
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
      ...(options.directPair
        ? { pair_binding: options.directPair }
        : {}),
      metadata: options.metadata ?? {
        definition_snapshot: DEFINITION,
        template_ref: 'intake-template-v1',
      },
    });
  };

  // ⚠ D-210 WS2 RE-AIMED THIS SUITE. The canonical log is now written at SUBMIT
  // by the intake handler, so an approve-time promotion writes for exactly one
  // shape: a D-200 direct-checkout pair, whose log is the paid deliverable and
  // may not exist before payment is verified. Every write test below is
  // therefore PAIRED — an unpaired approval is covered by its own no-write test.
  const paidAdmitter = () => vi.fn(async () => ({
    kind: 'admitted' as const,
    state_revision: 3,
    verified_at: ACCEPTED_AT - 1,
  }));

  it('writes nothing and decrypts nothing for an UNPAIRED approval (already logged at submit)', async () => {
    await seedSubmission();
    await auditLog.append(intakeAnchor());
    const onCreated = vi.fn();
    // A key getter that FAILS the test if called. The point is not only that no
    // row is written — it is that an unpaired approval never touches visitor
    // PII at all, because the plaintext was consumed at submit.
    const piiKeyReads = vi.fn(() => FORM_KEY);
    const promote = createFormResponsePromotion({
      auditLog,
      submissionStore,
      formResponseStore: responseStore,
      getFormSubmissionPiiKey: piiKeyReads,
      onCreated,
    });

    await expect(promote(intakeCheckpoint(), { approved_at: ACCEPTED_AT }))
      .resolves.toBeUndefined();

    expect(responseStore.list()).toEqual([]);
    expect(onCreated).not.toHaveBeenCalled();
    expect(piiKeyReads).not.toHaveBeenCalled();
  });

  it('decrypts the original submission and creates one immutable canonical response before resume', async () => {
    await seedSubmission({ directPair: DIRECT_PAIR });
    await auditLog.append(intakeAnchor());
    const created: string[] = [];
    const warehouseBus = createWarehouseEventBus();
    const warehouseEvents: WarehouseEvent[] = [];
    warehouseBus.subscribe(
      FORM_RESPONSE_CREATED_EVENT_PATTERN,
      (event) => warehouseEvents.push(event),
    );
    const realtimeEmit = vi.fn();
    const promote = createFormResponsePromotion({
      auditLog,
      submissionStore,
      formResponseStore: responseStore,
      getFormSubmissionPiiKey: () => FORM_KEY,
      admitPaidDirectCheckoutReview: paidAdmitter(),
      onCreated: (response) => {
        created.push(response.submission_id);
        emitFormResponseCreatedEvents({
          warehouseBus,
          realtimeBus: { emit: realtimeEmit },
        }, response);
      },
    });

    // Approval edits cannot redirect provenance: only original step input is
    // read, never checkpoint.arg_overrides.
    const checkpoint = intakeCheckpoint({
      arg_overrides: {
        metadata: {
          reception_form_submission_id: 'attacker-selected-submission',
        },
      },
    });
    await promote(checkpoint, { approved_at: ACCEPTED_AT });
    await promote(checkpoint, { approved_at: ACCEPTED_AT + 60_000 });

    // The held operation resumes only after promotion. Its store-only
    // projection verifies this exact canonical row and creates no second
    // entity; a missing/mismatched row fails closed in the projection suite.
    const projectionInput = (checkpoint.step_state.approved_operation as {
      input: ReceptionProjectionInput;
    }).input;
    await expect(runReceptionProjection({
      workEntityStore: {},
      formResponseStore: responseStore,
      now: () => ACCEPTED_AT,
    }, projectionInput)).resolves.toEqual({
      top_tier_kind: 'form_response',
      target_id: 'sub-1',
    });

    expect(responseStore.list()).toHaveLength(1);
    expect(created).toEqual(['sub-1']);
    expect(warehouseEvents).toHaveLength(1);
    expect(warehouseEvents[0]?.record_id).toBe('sub-1');
    expect(realtimeEmit).toHaveBeenCalledOnce();
    expect(responseStore.findById('sub-1')).toEqual({
      _id: 'sub-1',
      _collection: 'form_response',
      submission_id: 'sub-1',
      endpoint_id: 'ep-1',
      form_definition_id: 'form-1',
      definition_snapshot: DEFINITION,
      values: { budget: 2500, project: 'Northwind' },
      visitor: { email: 'visitor@example.test' },
      submitted_at: SUBMITTED_AT,
      accepted_at: ACCEPTED_AT,
      origin_actor: 'anonymous',
      origin_surface: 'system',
      // D-210 A.8 slice 2 — a promoted response is born in the default state
      // and has never transitioned. Asserted here rather than loosened to
      // `toMatchObject`: this is the one exact-shape check on the record, and
      // it is what catches a field silently joining or leaving it.
      lifecycle_state: 'received',
      state_changed_at: 0,
      metadata: { schema_version: 1, template_ref: 'intake-template-v1' },
    });
  });

  it('keeps a persisted response accepted when realtime invalidation throws', async () => {
    await seedSubmission({ directPair: DIRECT_PAIR });
    await auditLog.append(intakeAnchor());
    const promote = createFormResponsePromotion({
      auditLog,
      submissionStore,
      formResponseStore: responseStore,
      getFormSubmissionPiiKey: () => FORM_KEY,
      admitPaidDirectCheckoutReview: paidAdmitter(),
      onCreated: () => {
        throw new Error('broadcast unavailable');
      },
    });

    await expect(
      promote(intakeCheckpoint(), { approved_at: ACCEPTED_AT }),
    ).resolves.toBeUndefined();
    expect(responseStore.findById('sub-1')).not.toBeNull();
  });

  it('promotes a direct-checkout response only through exact paid admission', async () => {
    await seedSubmission({ directPair: DIRECT_PAIR });
    await auditLog.append(intakeAnchor());
    const admitPaidDirectCheckoutReview = vi.fn(async () => ({
      kind: 'admitted' as const,
      state_revision: 3,
      verified_at: ACCEPTED_AT - 1,
    }));
    const promote = createFormResponsePromotion({
      auditLog,
      submissionStore,
      formResponseStore: responseStore,
      getFormSubmissionPiiKey: () => FORM_KEY,
      admitPaidDirectCheckoutReview,
    });

    await expect(promote(intakeCheckpoint(), { approved_at: ACCEPTED_AT }))
      .resolves.toBeUndefined();
    expect(admitPaidDirectCheckoutReview).toHaveBeenCalledWith({
      submission_id: 'sub-1',
      pair_binding: DIRECT_PAIR,
      approved_at: ACCEPTED_AT,
    });
    expect(admitPaidDirectCheckoutReview).toHaveBeenCalledTimes(2);
    expect(responseStore.findById('sub-1')).not.toBeNull();
  });

  it('rechecks paid source truth after decryption and refuses a concurrent refund', async () => {
    await seedSubmission({ directPair: DIRECT_PAIR });
    await auditLog.append(intakeAnchor());
    const admission = vi.fn()
      .mockResolvedValueOnce({
        kind: 'admitted' as const,
        state_revision: 3,
        verified_at: ACCEPTED_AT - 1,
      })
      .mockResolvedValueOnce({
        kind: 'deferred' as const,
        reason: 'payment_unverified' as const,
      });
    const promote = createFormResponsePromotion({
      auditLog,
      submissionStore,
      formResponseStore: responseStore,
      getFormSubmissionPiiKey: () => FORM_KEY,
      admitPaidDirectCheckoutReview: admission,
    });

    await expect(promote(intakeCheckpoint(), { approved_at: ACCEPTED_AT }))
      .rejects.toMatchObject({ code: 'source_invalid' });
    expect(admission).toHaveBeenCalledTimes(2);
    expect(responseStore.findById('sub-1')).toBeNull();
  });

  it('refuses direct-checkout promotion when paid admission is absent or deferred', async () => {
    await seedSubmission({ directPair: DIRECT_PAIR });
    await auditLog.append(intakeAnchor());
    const base = {
      auditLog,
      submissionStore,
      formResponseStore: responseStore,
      getFormSubmissionPiiKey: () => FORM_KEY,
    };

    await expect(createFormResponsePromotion(base)(
      intakeCheckpoint(),
      { approved_at: ACCEPTED_AT },
    )).rejects.toMatchObject({ code: 'not_configured' });
    const deferred = vi.fn(async () => ({
      kind: 'deferred' as const,
      reason: 'approval_precedes_payment' as const,
    }));
    await expect(createFormResponsePromotion({
      ...base,
      admitPaidDirectCheckoutReview: deferred,
    })(intakeCheckpoint(), { approved_at: ACCEPTED_AT })).rejects.toMatchObject({
      code: 'source_invalid',
    });
    expect(responseStore.findById('sub-1')).toBeNull();
  });

  it('is a strict no-op for a non-intake preflight approval without reserved intake provenance', async () => {
    await auditLog.append(intakeAnchor({
      recipe_id: 'recued-core/mail-followup',
      execution_source: {
        channel: 'reactive',
        actor: 'system',
        event_kind: 'mail.created',
        source_recipe: 'recued-core/mail-followup',
      },
    }));
    const promote = createFormResponsePromotion({ auditLog });
    const unrelated = intakeCheckpoint({
      recipe_id: 'recued-core/mail-followup',
      step_state: {
        approved_operation: {
          input: {
            to: 'customer@example.test',
            metadata: { form_definition_id: 'ordinary-workflow-form' },
          },
        },
      },
    });

    await expect(promote(unrelated, {})).resolves.toBeUndefined();
    expect(responseStore.list()).toEqual([]);
  });

  it('D-210 A.8 — a SCHEDULING approval sharing the intake trigger event is NOT an intake', async () => {
    // 🔑 THE REGRESSION THIS EXISTS FOR. `event_kind` is minted as
    // `composition.<entity>` from the compiled recipe's trigger table, so it
    // discriminated intake from scheduling only while the two flows owned
    // separate tables. A.8 slice 4 merges `reception_booking_request` into
    // `reception_form_submission` — after which a scheduling approval carries
    // the SAME event_kind and satisfies every origin conjunct.
    //
    // Keyed on event_kind, this promoted a booking down the intake path, hit a
    // null provenance and threw. This hook decorates the SHARED preflight
    // resumer, so that is inbox approve, the generic ask queue, batch approve
    // and boot recovery breaking together — and it fails OPEN, since the
    // dispatcher's scope regex admits both names.
    //
    // A booking projection builds no `metadata` at all, so keying on the
    // flow's own provenance makes it a clean no-op instead.
    const bookingAnchor = intakeAnchor({
      run_id: 'run-booking-1',
      recipe_id: 'recued-core/reception-scheduling-review-then-approve-scheduling-materialize-1',
      execution_source: {
        channel: 'reactive',
        actor: 'system',
        // The post-merge collision, verbatim.
        event_kind: 'composition.reception_form_submission',
        source_recipe:
          'recued-core/reception-scheduling-review-then-approve-scheduling-materialize-1',
      },
    });
    await auditLog.append(bookingAnchor);
    const bookingCheckpoint = intakeCheckpoint({
      run_id: 'run-booking-1',
      recipe_id: 'recued-core/reception-scheduling-review-then-approve-scheduling-materialize-1',
      step_state: {
        approved_operation: {
          input: {
            // The real booking payload shape — no `metadata` key anywhere.
            top_tier_kind: 'booking',
            id: 'reception_booking-1',
            title: 'Table for four',
            start_at: SUBMITTED_AT,
            duration_minutes: 60,
            booking_request_id: 'req-1',
          },
        },
      },
    });
    const promote = createFormResponsePromotion({ auditLog });

    // A clean no-op — not a throw, and nothing promoted.
    await expect(
      promote(bookingCheckpoint, { approved_at: ACCEPTED_AT }),
    ).resolves.toBeUndefined();
    expect(responseStore.list()).toEqual([]);
  });

  it('fails closed when intake-shaped provenance is not backed by an authoritative intake anchor', async () => {
    await auditLog.append(intakeAnchor({
      execution_source: {
        channel: 'reactive',
        actor: 'system',
        event_kind: 'mail.created',
        source_recipe: 'recued-core/reception-intake-review-then-approve-intake-materialize-1',
      },
    }));
    const promote = createFormResponsePromotion({ auditLog });

    await expect(promote(intakeCheckpoint(), { approved_at: ACCEPTED_AT })).rejects.toMatchObject({
      code: 'source_invalid',
    });
  });

  it('fails closed before resume when an intake approval substrate is unavailable', async () => {
    await auditLog.append(intakeAnchor());
    const promote = createFormResponsePromotion({ auditLog });

    await expect(promote(intakeCheckpoint(), { approved_at: ACCEPTED_AT })).rejects.toMatchObject({
      name: 'FormResponsePromotionError',
      code: 'not_configured',
    });
  });

  it('refuses a mutable/missing definition snapshot', async () => {
    await seedSubmission({
      directPair: DIRECT_PAIR,
      metadata: { template_ref: 'legacy-without-snapshot' },
    });
    await auditLog.append(intakeAnchor());
    const promote = createFormResponsePromotion({
      auditLog,
      submissionStore,
      formResponseStore: responseStore,
      getFormSubmissionPiiKey: () => FORM_KEY,
      admitPaidDirectCheckoutReview: paidAdmitter(),
    });

    await expect(promote(intakeCheckpoint(), { approved_at: ACCEPTED_AT })).rejects.toBeInstanceOf(
      FormResponsePromotionError,
    );
    expect(responseStore.findById('sub-1')).toBeNull();
  });

  it('refuses inconsistent independently sealed visitor email fields', async () => {
    await seedSubmission({
      directPair: DIRECT_PAIR,
      separatelySealedEmail: 'different@example.test',
    });
    await auditLog.append(intakeAnchor());
    const promote = createFormResponsePromotion({
      auditLog,
      submissionStore,
      formResponseStore: responseStore,
      getFormSubmissionPiiKey: () => FORM_KEY,
      admitPaidDirectCheckoutReview: paidAdmitter(),
    });

    await expect(promote(intakeCheckpoint(), { approved_at: ACCEPTED_AT })).rejects.toMatchObject({
      code: 'source_invalid',
    });
    expect(responseStore.findById('sub-1')).toBeNull();
  });

  it('refuses an intake resume without the durable affirmative-answer timestamp', async () => {
    await seedSubmission();
    await auditLog.append(intakeAnchor());
    const promote = createFormResponsePromotion({
      auditLog,
      submissionStore,
      formResponseStore: responseStore,
      getFormSubmissionPiiKey: () => FORM_KEY,
    });

    await expect(promote(intakeCheckpoint(), {})).rejects.toMatchObject({
      code: 'source_invalid',
    });
    expect(responseStore.findById('sub-1')).toBeNull();
  });
});
