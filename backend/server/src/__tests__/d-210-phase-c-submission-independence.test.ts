/** D-210 Phase C — DOES A HELD SUBMISSION BLOCK THE NEXT ONE?
 *
 *  Owner raised the concern (2026-07-18): "each submission is a new session,
 *  so there's nothing to hold against — a previous queue in the inbox
 *  blocking all future submissions is not the right design."
 *
 *  That is a checkable claim about what the substrate does TODAY, so this
 *  suite checks it instead of arguing about it. It drives the REAL intake
 *  processor over a REAL submission store with several pending rows and
 *  observes how many get dispatched.
 *
 *  What it establishes:
 *    - N pending submissions in one drain tick produce N INDEPENDENT
 *      dispatches; none waits on another;
 *    - a submission already held (dispatched, `processed`) does not
 *      re-appear and does not gate the next tick;
 *    - the one thing that genuinely DOES stop the tick is a locked vault —
 *      a key problem, not a queue problem.
 *
 *  Harness copied from `d-173-reception-drain-single-path.test.ts`. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECUED_BUILTIN_SOURCE_ID,
  formatApprovalLinkConsumedOutcome,
  type ApprovalLinkConfig,
  type IntakeFormConfig,
  type ReceptionFormPairBinding,
} from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createReceptionFormSubmissionStore,
  type FormSubmissionStore,
} from '../storage/reception-form-store.js';
import {
  createReceptionApprovalIntentStore,
  type ApprovalIntentStore,
} from '../storage/reception-approval-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  sealFormSubmissionField,
} from '../ports/reception/form-pii.js';
import {
  deriveApprovalIntentPiiKeyFromSubDek,
  sealApprovalIntentPiiField,
} from '../ports/reception/approval-pii.js';
import { computeBearerHmac, deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import { createIntakeFormSubmissionProcessor } from '../ports/reception/processors/intake-form-processor.js';
import { createApprovalLinkSubmissionProcessor } from '../ports/reception/processors/approval-link-processor.js';
import type {
  FireReceptionWorkflow,
  ReceptionWorkflowDispatch,
} from '../ports/reception/reception-drain.js';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xc4));
const FORM_KEY = deriveFormSubmissionPiiKeyFromSubDek(Buffer.alloc(32, 0x5a));
const APPROVAL_KEY = deriveApprovalIntentPiiKeyFromSubDek(Buffer.alloc(32, 0x5a));

interface Env {
  registry: PublicEndpointRegistryStore;
  formStore: FormSubmissionStore;
  intentStore: ApprovalIntentStore;
  workStore: WorkEntityStore;
  /** The recording seam — every review-mode dispatch is captured here. */
  fired: ReceptionWorkflowDispatch[];
  /** The seam (dispatches `{ dispatched: true }` by default). */
  fireReceptionWorkflow: FireReceptionWorkflow;
}

const buildEnv = (opts: { seamDispatches?: boolean } = {}): Env => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  ensureWorkEntitySchema(db);
  const workStore = createWorkEntityStore(db);
  autoRegisterRecuedBuiltinSources(workStore, NOW);
  const fired: ReceptionWorkflowDispatch[] = [];
  const dispatched = opts.seamDispatches ?? true;
  const fireReceptionWorkflow: FireReceptionWorkflow = vi.fn(async (d) => {
    fired.push(d);
    return { dispatched };
  });
  return {
    registry: createPublicEndpointRegistryStore(db),
    formStore: createReceptionFormSubmissionStore(db),
    intentStore: createReceptionApprovalIntentStore(db),
    workStore,
    fired,
    fireReceptionWorkflow,
  };
};

// ────────────────────────────────────────────────────────────────
// intake_form fixtures
// ────────────────────────────────────────────────────────────────

const intakeConfig = (
  /** ⚠ This parameter used to accept a `'log_only'` SENTINEL standing for an
   *  ABSENT `target_kind`. D-210 A.8 slice 2b step 3 retired absence as a
   *  value, so the sentinel went with it — that meaning is now spelled
   *  `'form_response'` like any other destination. The default stays `'task'`
   *  so no existing caller silently changes destination. */
  target_kind: IntakeFormConfig['submission_processing_rule']['target_kind'] = 'task',
): IntakeFormConfig => ({
  display_name: 'Mary',
  form_definition: {
    form_definition_id: 'fd_sp',
    fields: [
      { name: 'subject', type: 'text', label: 'Subject', required: true },
      { name: 'details', type: 'textarea', label: 'Details', required: true },
      { name: 'budget', type: 'text', label: 'Budget', required: false },
    ],
  },
  submission_processing_rule: {
    target_kind,
    fields_to_include_in_target: ['subject', 'details'],
    fields_to_attach_as_metadata: ['budget'],
  },
  anti_spam: { honeypot_fields: [], rate_limit_per_ip: 5, require_proof_of_work: false, require_captcha: false },
  required_visitor_fields: { email: 'optional' },
});

const seedIntakeEndpoint = (env: Env, endpoint_id: string, config: IntakeFormConfig): void => {
  env.registry.create({
    endpoint_id,
    kind: 'intake_form',
    packet_declaration: {
      packet_kind: 'intake_form_packet',
      source_query_ref: { kind: 'reception_form_definition', form_definition_id: 'fd_sp' },
    },
    bearer_secret_hmac: computeBearerHmac('tok', PEPPER),
    created_at: NOW - 1000,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: NOW - 1000,
    metadata: config as unknown as Record<string, unknown>,
  });
  env.registry.enable(endpoint_id, NOW);
};

const seedIntakeSubmission = async (
  env: Env,
  input: {
    endpoint_id: string;
    submission_id: string;
    fields: Record<string, unknown>;
    pair_binding?: ReceptionFormPairBinding;
  },
): Promise<void> => {
  const blobJson = JSON.stringify({ fields: input.fields });
  const submission_blob_encrypted = await sealFormSubmissionField({
    key: FORM_KEY,
    endpoint_id: input.endpoint_id,
    submission_id: input.submission_id,
    field: 'submission_blob',
    plaintext: blobJson,
  });
  env.formStore.insert({
    submission_id: input.submission_id,
    endpoint_id: input.endpoint_id,
    form_definition_id: 'fd_sp',
    submitted_at: NOW - 500,
    source_ip_hash: null,
    visitor_email_encrypted: null,
    submission_blob_encrypted: submission_blob_encrypted!,
    schema_version: 1,
    processing_outcome: 'pending',
    ...(input.pair_binding
      ? { pair_binding: input.pair_binding }
      : {}),
  });
};

const intakeProcessor = (
  env: Env,
  wireSeam = true,
  admitPaidDirectCheckoutReview?: Parameters<
    typeof createIntakeFormSubmissionProcessor
  >[0]['admitPaidDirectCheckoutReview'],
) =>
  createIntakeFormSubmissionProcessor({
    registryStore: env.registry,
    submissionStore: env.formStore,
    workEntityStore: env.workStore,
    getFormSubmissionPiiKey: () => FORM_KEY,
    now: () => NOW,
    ...(wireSeam ? { fireReceptionWorkflow: env.fireReceptionWorkflow } : {}),
    ...(admitPaidDirectCheckoutReview ? { admitPaidDirectCheckoutReview } : {}),
  });


// ────────────────────────────────────────────────────────────────
// The question: does a queued hold block the next submission?
// ────────────────────────────────────────────────────────────────

describe('D-210 Phase C — held submissions are independent of each other', () => {
  it('THREE pending submissions in ONE tick produce THREE dispatches', async () => {
    const env = buildEnv();
    seedIntakeEndpoint(env, 'ep-indep', intakeConfig());
    for (const id of ['sub-a', 'sub-b', 'sub-c']) {
      await seedIntakeSubmission(env, {
        endpoint_id: 'ep-indep',
        submission_id: id,
        fields: { subject: `S ${id}`, details: `D ${id}` },
      });
    }

    const result = await intakeProcessor(env).drainOnce({ now: NOW, limit: 50 });

    // The claim under test. If a pending hold gated the queue, this would be 1.
    expect(result.processed).toBe(3);
    expect(result.failed).toBe(0);
    expect(env.fired).toHaveLength(3);
    // Each carries its OWN source record — three separate held ops, not one
    // batched decision over three.
    expect(env.fired.map((f) => f.source_ref).sort()).toEqual(['sub-a', 'sub-b', 'sub-c']);
    // And three distinct projection ids, so nothing collides on approve.
    const ids = env.fired.map((f) => (f.payload as { id: string }).id);
    expect(new Set(ids).size).toBe(3);
  });

  it('an ALREADY-HELD submission does not gate the next tick', async () => {
    const env = buildEnv();
    seedIntakeEndpoint(env, 'ep-indep', intakeConfig());
    await seedIntakeSubmission(env, {
      endpoint_id: 'ep-indep',
      submission_id: 'sub-first',
      fields: { subject: 'first', details: 'first' },
    });

    // Tick 1 — dispatched and held. It is NOT approved; it sits in the inbox.
    expect((await intakeProcessor(env).drainOnce({ now: NOW, limit: 50 })).processed).toBe(1);

    // A new visitor submits while the first is still waiting for the owner.
    await seedIntakeSubmission(env, {
      endpoint_id: 'ep-indep',
      submission_id: 'sub-second',
      fields: { subject: 'second', details: 'second' },
    });

    const tick2 = await intakeProcessor(env).drainOnce({ now: NOW, limit: 50 });

    // The second dispatches immediately — the unapproved first is irrelevant.
    expect(tick2.processed).toBe(1);
    expect(env.fired.map((f) => f.source_ref)).toEqual(['sub-first', 'sub-second']);
    // And the first is not re-dispatched: it flipped `processed` at hand-off,
    // so the held op + the inbox own its lifecycle from there.
    expect(env.fired.filter((f) => f.source_ref === 'sub-first')).toHaveLength(1);
  });

  it('a LOCKED VAULT is the one thing that really does stop the tick', async () => {
    // Named so the real blocking condition is not mistaken for a queue
    // problem: it is a key problem, it stops the whole tick (not one row),
    // and every row stays `pending` for the next cycle after unlock.
    const env = buildEnv();
    seedIntakeEndpoint(env, 'ep-indep', intakeConfig());
    for (const id of ['sub-x', 'sub-y']) {
      await seedIntakeSubmission(env, {
        endpoint_id: 'ep-indep',
        submission_id: id,
        fields: { subject: id, details: id },
      });
    }

    const locked = createIntakeFormSubmissionProcessor({
      registryStore: env.registry,
      submissionStore: env.formStore,
      workEntityStore: env.workStore,
      getFormSubmissionPiiKey: () => undefined as unknown as Uint8Array,
      now: () => NOW,
      fireReceptionWorkflow: env.fireReceptionWorkflow,
    });
    const result = await locked.drainOnce({ now: NOW, limit: 50 });

    expect(result.processed).toBe(0);
    expect(env.fired).toEqual([]);
    // Rows survive for the next cycle — nothing is lost or failed.
    expect(env.formStore.findById('sub-x')?.processing_outcome).toBe('pending');
    expect(env.formStore.findById('sub-y')?.processing_outcome).toBe('pending');
  });
});
