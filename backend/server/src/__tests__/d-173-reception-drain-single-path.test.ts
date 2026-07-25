/** D-173 P3 § A.7 / D-210 Phase C — the reception drain's SINGLE path, over a
 *  recording `fireReceptionWorkflow` seam + a real work-entity warehouse.
 *
 *  ⚠ D-210 Phase C RE-AIMED THIS SUITE. It used to prove the REVIEW/AUTO-ACCEPT
 *  fork: review dispatches and materializes nothing, auto-accept materializes
 *  byte-identically to the retired D-149 drain, and a mixed batch does exactly
 *  one of each. `auto_accept` is now retired on all three reception kinds
 *  (owner ruling, 2026-07-18), so there is no fork — the six auto-accept tests
 *  went with their subject.
 *
 *  What it proves now:
 *    1. REVIEW + seam wired → the processor DISPATCHES the review-then-approve
 *       workflow exactly once (the projection-shaped payload) and materializes
 *       NOTHING (no ambient warehouse write — I-1). The row flips `processed`
 *       (handed off — the held op + inbox own the lifecycle).
 *    2. REVIEW + seam UNWIRED → the row stays PENDING. It must NEVER fall back
 *       to materialize, which would bypass review entirely.
 *    3. A processed row is not re-drained.
 *    4. A spoofed visitor value cannot escape its projection (it lands as the
 *       server-chosen kind, contained).
 *
 *  (Per-target materialization SHAPES are the approve-leg projection's, not the
 *  drain's — see `reception-projection` and its tests.) */

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
// approval_link fixtures
// ────────────────────────────────────────────────────────────────

const approvalConfig = (): ApprovalLinkConfig => ({
  display_name: 'Mary',
  action_kind: 'approve_wording',
  prompt: 'Please approve the wording.',
  context_raw: { summary: 'single-path approval.' },
  visitor_field_constraints: { name: 'optional', email: 'optional' },
  expiry_days: 7,
  on_action: {
    target_id: 'target-1',
    on_approve_action: 'create_commitment',
  },
});

const seedApprovalEndpoint = (env: Env, endpoint_id: string, config: ApprovalLinkConfig): void => {
  env.registry.create({
    endpoint_id,
    kind: 'approval_link',
    packet_declaration: {
      packet_kind: 'approval_link_packet',
      source_query_ref: { kind: 'reception_approval_intent', intent_id: endpoint_id },
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

const consumeApproval = async (
  env: Env,
  input: { endpoint_id: string; intent_id: string },
): Promise<void> => {
  env.intentStore.create({
    intent_id: input.intent_id,
    endpoint_id: input.endpoint_id,
    action_kind: 'approve_wording',
    target_id: 'target-1',
    metadata: { seeded_by: 'd-173-single-path' },
  });
  const outcomeWire = formatApprovalLinkConsumedOutcome({ kind: 'approve' });
  const outcome_encrypted = await sealApprovalIntentPiiField({
    key: APPROVAL_KEY,
    endpoint_id: input.endpoint_id,
    intent_id: input.intent_id,
    field: 'outcome',
    plaintext: outcomeWire,
  });
  const res = env.intentStore.tryConsume({
    intent_id: input.intent_id,
    endpoint_id: input.endpoint_id,
    now: NOW - 500,
    source_ip_hash: 'ip-hash',
    visitor_email_encrypted: null,
    visitor_name_encrypted: null,
    outcome_encrypted: outcome_encrypted!,
    metadata_patch: { outcome_kind: 'approve' },
  });
  expect(res.ok).toBe(true);
};

const approvalProcessor = (env: Env, wireSeam = true) =>
  createApprovalLinkSubmissionProcessor({
    registryStore: env.registry,
    intentStore: env.intentStore,
    workEntityStore: env.workStore,
    getApprovalIntentPiiKey: () => APPROVAL_KEY,
    now: () => NOW,
    ...(wireSeam ? { fireReceptionWorkflow: env.fireReceptionWorkflow } : {}),
  });

// ════════════════════════════════════════════════════════════════
// intake_form — the single path
// ════════════════════════════════════════════════════════════════

describe('D-173 single-path — intake_form review-by-default', () => {
  let env: Env;
  beforeEach(() => {
    env = buildEnv();
  });

  // ⚠ NON-DEFAULT ROUTING. Every other intake fixture in the suite uses
  // `target_kind: 'task'`, which is ALSO what `topTierKindForTarget` returned
  // from its old `default:` arm — so those tests would still pass if the mapper
  // were broken to always answer 'task'. This drives a target_kind that has no
  // fallback behind it, so the mapping itself is what is under test.
  it('routes a BOOKING target_kind to top_tier_kind booking (non-default mapping)', async () => {
    seedIntakeEndpoint(env, 'ep-booking', intakeConfig('booking'));
    await seedIntakeSubmission(env, {
      endpoint_id: 'ep-booking',
      submission_id: 'sub-booking',
      fields: { subject: 'Table for four', details: 'Friday evening', budget: '' },
    });

    await intakeProcessor(env).drainOnce({ now: NOW, limit: 50 });

    expect(env.fired).toHaveLength(1);
    expect(env.fired[0]!.payload).toMatchObject({
      top_tier_kind: 'booking',
      id: 'reception_sub-booking',
      title: 'Table for four',
    });
  });

  it('REVIEW (default) DISPATCHES the workflow once + materializes NOTHING (I-1)', async () => {
    seedIntakeEndpoint(env, 'ep-review', intakeConfig());
    await seedIntakeSubmission(env, {
      endpoint_id: 'ep-review',
      submission_id: 'sub-review',
      fields: { subject: 'Coffee chat request', details: 'from a visitor at the booth', budget: '$5k' },
    });

    const res = await intakeProcessor(env).drainOnce({ now: NOW, limit: 50 });

    // The workflow seam fired EXACTLY once — with the projection-shaped payload.
    expect(env.fired).toHaveLength(1);
    expect(env.fired[0]!.kind).toBe('intake_form');
    expect(env.fired[0]!.source_ref).toBe('sub-review');
    expect(env.fired[0]!.endpoint_id).toBe('ep-review');
    expect(env.fired[0]!.payload).toMatchObject({
      top_tier_kind: 'task',
      id: 'reception_sub-review',
      title: 'Coffee chat request', // first non-empty included field
      body: 'Subject: Coffee chat request\nDetails: from a visitor at the booth',
    });
    // Provenance metadata rides along (the materialize destination's blob).
    expect((env.fired[0]!.payload.metadata as Record<string, unknown>)).toMatchObject({
      reception_form_submission_id: 'sub-review',
      reception_endpoint_id: 'ep-review',
      budget: '$5k',
    });

    // NOTHING materialized — review holds the materialize at the gate; it runs
    // only on the user's explicit approve.
    expect(env.workStore.countTasks()).toBe(0);
    expect(env.workStore.readTask('reception_sub-review')).toBeNull();

    // The row was handed off → processed (no resolved target yet).
    const row = env.formStore.findById('sub-review')!;
    expect(row.processing_outcome).toBe('processed');
    expect(row.resolved_target_id).toBeNull();
    expect(res).toEqual({ processed: 1, failed: 0 });
  });

  it('REVIEW can retain only the canonical FormResponse without proposing another entity', async () => {
    const responseConfig = intakeConfig('form_response');
    seedIntakeEndpoint(env, 'ep-response', {
      ...responseConfig,
      anti_spam: {
        ...responseConfig.anti_spam,
        honeypot_fields: ['budget'],
      },
    });
    await seedIntakeSubmission(env, {
      endpoint_id: 'ep-response',
      submission_id: 'sub-response',
      fields: { subject: 'A free-form request', details: 'Keep the original answers' },
    });

    const res = await intakeProcessor(env).drainOnce({ now: NOW, limit: 50 });

    expect(env.fired).toHaveLength(1);
    expect(env.fired[0]!.payload).toMatchObject({
      top_tier_kind: 'form_response',
      id: 'sub-response',
      title: 'Mary form submission',
      body: [
        'Subject: A free-form request',
        'Details: Keep the original answers',
      ].join('\n'),
    });
    expect(env.fired[0]!.payload.metadata).toMatchObject({
      reception_form_submission_id: 'sub-response',
      reception_endpoint_id: 'ep-response',
      form_definition_id: 'fd_sp',
    });
    expect(env.fired[0]!.payload.metadata).not.toHaveProperty('budget');
    expect(env.workStore.countTasks()).toBe(0);
    expect(env.workStore.countNotes()).toBe(0);
    expect(env.workStore.countCommitments()).toBe(0);
    expect(env.formStore.findById('sub-response')!.processing_outcome).toBe('processed');
    expect(res).toEqual({ processed: 1, failed: 0 });
  });

  it('keeps a direct-checkout response pending until exact paid admission', async () => {
    const responseConfig = intakeConfig('form_response');
    seedIntakeEndpoint(env, 'ep-direct-response', {
      ...responseConfig,
      required_visitor_fields: { email: 'required' },
    });
    const pair: ReceptionFormPairBinding = {
      version: 1,
      form_definition_id: 'fd_sp',
      recipe_id: 'direct-document-checkout',
      recipe_version: 3,
      pair_revision: `d200-pair-v1-${'a'.repeat(64)}`,
    };
    await seedIntakeSubmission(env, {
      endpoint_id: 'ep-direct-response',
      submission_id: 'sub-direct-response',
      fields: { subject: 'Paid request', details: 'Review only after payment' },
      pair_binding: pair,
    });
    const defer = vi.fn(async () => ({
      kind: 'deferred' as const,
      reason: 'payment_unverified' as const,
    }));

    await expect(intakeProcessor(env).drainOnce({ now: NOW, limit: 50 }))
      .resolves.toEqual({ processed: 0, failed: 0 });
    expect(env.fired).toEqual([]);
    expect(env.formStore.findById('sub-direct-response')?.processing_outcome)
      .toBe('pending');

    await expect(intakeProcessor(env, true, defer).drainOnce({ now: NOW, limit: 50 }))
      .resolves.toEqual({ processed: 0, failed: 0 });
    expect(defer).toHaveBeenCalledWith({
      submission_id: 'sub-direct-response',
      pair_binding: pair,
    });
    expect(env.fired).toEqual([]);
    expect(env.formStore.findById('sub-direct-response')?.processing_outcome)
      .toBe('pending');

    const changedAfterDecrypt = vi.fn()
      .mockResolvedValueOnce({
        kind: 'admitted' as const,
        state_revision: 3,
        verified_at: NOW - 1,
      })
      .mockResolvedValueOnce({
        kind: 'deferred' as const,
        reason: 'payment_unverified' as const,
      });
    await expect(intakeProcessor(env, true, changedAfterDecrypt).drainOnce({
      now: NOW,
      limit: 50,
    })).resolves.toEqual({ processed: 0, failed: 0 });
    expect(changedAfterDecrypt).toHaveBeenCalledTimes(2);
    expect(env.fired).toEqual([]);

    const admit = vi.fn(async () => ({
      kind: 'admitted' as const,
      state_revision: 3,
      verified_at: NOW - 1,
    }));
    await expect(intakeProcessor(env, true, admit).drainOnce({ now: NOW, limit: 50 }))
      .resolves.toEqual({ processed: 1, failed: 0 });
    expect(admit).toHaveBeenCalledTimes(2);
    expect(env.fired).toHaveLength(1);
    expect(env.fired[0]?.payload).toMatchObject({
      top_tier_kind: 'form_response',
      id: 'sub-direct-response',
    });
    expect(env.formStore.findById('sub-direct-response')?.processing_outcome)
      .toBe('processed');
  });

  // D-210 §3 — the GENERAL rule the two tests above only pin incidentally, under a payment
  // name. A row carrying ANY pair binding was owned by the submit path: `coordinatePairedRun`
  // ran the owner's recipe through the D-207 gated runner and its ops held at the Gateway.
  // The compiled review-then-approve recipe is the DEFAULT — what a submission becomes when
  // the owner paired NOTHING — so firing it here would be a SECOND artifact for one
  // submission. This pins the rule by its own name, and with NO payment machinery in sight:
  // no admitter is wired, and the pair is an ordinary D-207 pair, not a `d200-` one.
  it('D-210 — a paired row NEVER reaches the DEFAULT funnel (the submit path owns it)', async () => {
    const responseConfig = intakeConfig('form_response');
    seedIntakeEndpoint(env, 'ep-general-pair', {
      ...responseConfig,
      required_visitor_fields: { email: 'required' },
    });
    // ⚠ An ordinary D-207 pair for a FREE form that sells nothing — and note it still
    // carries the `d200-pair-v1-` revision prefix. That prefix is a FROZEN STORAGE FORMAT
    // baked into every persisted binding (`RECEPTION_PAIR_REVISION_PREFIX`), NOT a marker
    // of D-200's paid profile. There is no discriminator: a general pair and a D-200 pair
    // are indistinguishable at this seam, which is exactly WHY the rule must key on the
    // binding's PRESENCE and let the dying payment admitter be the one exception.
    const pair: ReceptionFormPairBinding = {
      version: 1,
      // Must equal the row's own `form_definition_id` — the store binds the two.
      form_definition_id: 'fd_sp',
      recipe_id: 'greet-the-visitor',
      recipe_version: 1,
      pair_revision: `d200-pair-v1-${'b'.repeat(64)}`,
    };
    await seedIntakeSubmission(env, {
      endpoint_id: 'ep-general-pair',
      submission_id: 'sub-general-pair',
      fields: { subject: 'Hello', details: 'A plain paired form, nothing paid' },
      pair_binding: pair,
    });

    // No paid admitter wired — the ordinary shape for a general pair. The row must be left
    // alone: not dispatched, and not classified `failed` (it is not a poison row).
    await expect(intakeProcessor(env).drainOnce({ now: NOW, limit: 50 }))
      .resolves.toEqual({ processed: 0, failed: 0 });
    expect(env.fired).toEqual([]);
    expect(env.formStore.findById('sub-general-pair')?.processing_outcome)
      .toBe('pending');

    // And it stays refused on a re-drain — the fence is the BINDING, not a one-shot latch.
    await expect(intakeProcessor(env).drainOnce({ now: NOW, limit: 50 }))
      .resolves.toEqual({ processed: 0, failed: 0 });
    expect(env.fired).toEqual([]);
  });

  it('advances past a deferred direct row so a later paid row is not starved', async () => {
    const responseConfig = intakeConfig('form_response');
    seedIntakeEndpoint(env, 'ep-direct-fair', {
      ...responseConfig,
      required_visitor_fields: { email: 'required' },
    });
    const pair: ReceptionFormPairBinding = {
      version: 1,
      form_definition_id: 'fd_sp',
      recipe_id: 'direct-document-checkout',
      recipe_version: 3,
      pair_revision: `d200-pair-v1-${'d'.repeat(64)}`,
    };
    for (const submission_id of ['sub-direct-a-unpaid', 'sub-direct-b-paid']) {
      await seedIntakeSubmission(env, {
        endpoint_id: 'ep-direct-fair',
        submission_id,
        fields: { subject: submission_id, details: 'Stable cursor proof' },
        pair_binding: pair,
      });
    }
    const admission = vi.fn(async ({ submission_id }: { submission_id: string }) =>
      submission_id === 'sub-direct-b-paid'
        ? {
            kind: 'admitted' as const,
            state_revision: 3,
            verified_at: NOW - 1,
          }
        : {
            kind: 'deferred' as const,
            reason: 'payment_unverified' as const,
          });
    const processor = intakeProcessor(env, true, admission);

    await expect(processor.drainOnce({ now: NOW, limit: 1 }))
      .resolves.toEqual({ processed: 0, failed: 0 });
    await expect(processor.drainOnce({ now: NOW, limit: 1 }))
      .resolves.toEqual({ processed: 1, failed: 0 });

    expect(env.fired).toHaveLength(1);
    expect(env.fired[0]?.source_ref).toBe('sub-direct-b-paid');
    expect(env.formStore.findById('sub-direct-a-unpaid')?.processing_outcome)
      .toBe('pending');
    expect(env.formStore.findById('sub-direct-b-paid')?.processing_outcome)
      .toBe('processed');
  });

  it('REVIEW with NO seam wired leaves the row PENDING + materializes NOTHING (no fallback — I-1)', async () => {
    seedIntakeEndpoint(env, 'ep-noseam', intakeConfig());
    await seedIntakeSubmission(env, {
      endpoint_id: 'ep-noseam',
      submission_id: 'sub-noseam',
      fields: { subject: 's', details: 'd' },
    });

    const res = await intakeProcessor(env, /* wireSeam */ false).drainOnce({ now: NOW, limit: 50 });

    // The drain MUST NOT auto-materialize as a fallback (that would bypass
    // review). The row stays pending to dispatch once the recipe installs.
    expect(env.workStore.countTasks()).toBe(0);
    expect(env.formStore.findById('sub-noseam')!.processing_outcome).toBe('pending');
    expect(res).toEqual({ processed: 0, failed: 0 });
  });

  it('NO DOUBLE — a re-drain after a review dispatch fires NOTHING again + still no materialize', async () => {
    seedIntakeEndpoint(env, 'ep-redrain', intakeConfig());
    await seedIntakeSubmission(env, {
      endpoint_id: 'ep-redrain',
      submission_id: 'sub-redrain',
      fields: { subject: 's', details: 'd' },
    });

    const proc = intakeProcessor(env);
    await proc.drainOnce({ now: NOW, limit: 50 });
    await proc.drainOnce({ now: NOW, limit: 50 }); // re-sweep — the row is now processed

    // Exactly one dispatch total (the first sweep handed it off + marked
    // processed; the second sweep sees no pending row → no second fire).
    expect(env.fired).toHaveLength(1);
    expect(env.workStore.countTasks()).toBe(0);
  });

});

// ════════════════════════════════════════════════════════════════
// processor-spoof hardening — visitor `top_tier_kind` containment
// ════════════════════════════════════════════════════════════════

/** The drain stamps the projection-payload ROOT `top_tier_kind` from server
 *  config (`topTierKindForTarget(rule.target_kind)`); visitor field VALUES land
 *  NESTED under `metadata` (`buildEntityShape`). Both consumers read the ROOT —
 *  the inbox label resolver (`defaultResolveInboxSource`) AND the materialize
 *  (`runReceptionProjection`). So a visitor who fills a form field literally
 *  NAMED `top_tier_kind` must never flip the destination class.
 *
 *  This guards a future refactor that spreads visitor fields at the payload root
 *  (e.g. `payload: { ...shape.metadata, top_tier_kind, id }`) — which would let
 *  `metadata.top_tier_kind` clobber the server root. The live e2e
 *  (`/tmp/recued-d173-spoof/`) proves current behavior; THIS is the durable
 *  build-time guard. intake_form is the only kind with a visitor-named-field
 *  surface (drop = fixed metadata keys, approval = option/answer → statement),
 *  so the spoof is only reachable here. */
const spoofIntakeConfig = (): IntakeFormConfig => ({
  display_name: 'Mary',
  form_definition: {
    form_definition_id: 'fd_sp',
    fields: [
      { name: 'subject', type: 'text', label: 'Subject', required: true },
      // The attack surface: a field literally named `top_tier_kind`.
      { name: 'top_tier_kind', type: 'text', label: 'Top tier kind', required: false },
    ],
  },
  submission_processing_rule: {
    target_kind: 'task', // server says TASK
    fields_to_include_in_target: ['subject'],
    fields_to_attach_as_metadata: ['top_tier_kind'], // visitor value → nested metadata
  },
  anti_spam: { honeypot_fields: [], rate_limit_per_ip: 5, require_proof_of_work: false, require_captcha: false },
  required_visitor_fields: { email: 'optional' },
});

describe('D-173 processor-spoof hardening — top_tier_kind stays server-stamped', () => {
  let env: Env;
  beforeEach(() => {
    env = buildEnv();
  });

  it('REVIEW: a visitor field named top_tier_kind nests in metadata — the payload ROOT stays server task', async () => {
    seedIntakeEndpoint(env, 'ep-spoof', spoofIntakeConfig());
    await seedIntakeSubmission(env, {
      endpoint_id: 'ep-spoof',
      submission_id: 'sub-spoof',
      fields: { subject: 'Please book the venue', top_tier_kind: 'commitment' }, // the spoof
    });

    await intakeProcessor(env).drainOnce({ now: NOW, limit: 50 });

    expect(env.fired).toHaveLength(1);
    const payload = env.fired[0]!.payload;
    // THE GUARD: the ROOT top_tier_kind is the SERVER class (task), never the
    // visitor's `commitment`. A `{...metadata}`-at-root refactor breaks this.
    expect(payload.top_tier_kind).toBe('task');
    // The visitor value IS present — contained NESTED in metadata (submitted +
    // projected, not dropped), where it can never be read as the entity kind.
    expect((payload.metadata as Record<string, unknown>).top_tier_kind).toBe('commitment');
    // Nothing materialized in review mode (I-1).
    expect(env.workStore.countTasks()).toBe(0);
    expect(env.workStore.countCommitments()).toBe(0);
  });

});

// ════════════════════════════════════════════════════════════════
// approval_link — the single path
// ════════════════════════════════════════════════════════════════

describe('D-173 single-path — approval_link review-by-default', () => {
  let env: Env;
  beforeEach(() => {
    env = buildEnv();
  });

  it('REVIEW (default) DISPATCHES the workflow once + materializes NO commitment (I-1)', async () => {
    seedApprovalEndpoint(env, 'ap-review', approvalConfig());
    await consumeApproval(env, { endpoint_id: 'ap-review', intent_id: 'int-review' });

    const res = await approvalProcessor(env).drainOnce({ now: NOW, limit: 50 });

    expect(env.fired).toHaveLength(1);
    expect(env.fired[0]!.kind).toBe('approval_link');
    expect(env.fired[0]!.source_ref).toBe('int-review');
    expect(env.fired[0]!.payload).toMatchObject({
      top_tier_kind: 'commitment',
      id: 'reception_int-review',
    });

    // NO commitment materialized — held at the gate until approve.
    expect(env.workStore.countCommitments()).toBe(0);
    expect(env.workStore.readCommitment('reception_int-review')).toBeNull();

    // The intent was handed off → processed.
    expect(env.intentStore.findByEndpoint('ap-review')!.processing_outcome).toBe('processed');
    expect(res).toEqual({ processed: 1, failed: 0 });
  });

  it('REVIEW with NO seam wired leaves the intent PENDING + no commitment (no fallback — I-1)', async () => {
    seedApprovalEndpoint(env, 'ap-noseam', approvalConfig());
    await consumeApproval(env, { endpoint_id: 'ap-noseam', intent_id: 'int-noseam' });

    const res = await approvalProcessor(env, /* wireSeam */ false).drainOnce({ now: NOW, limit: 50 });

    expect(env.workStore.countCommitments()).toBe(0);
    expect(env.intentStore.findByEndpoint('ap-noseam')!.processing_outcome).toBe('pending');
    expect(res).toEqual({ processed: 0, failed: 0 });
  });

});
