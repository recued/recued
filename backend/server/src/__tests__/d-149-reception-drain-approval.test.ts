/** D-149 A.5.5 + Must Hold I-12 - approval_link consumption drain.
 *
 *  D-173 P3 § A.7 NOTE — the drain's `create_commitment` *auto-materialize* is
 *  no longer the default; it is the **auto-accept** branch (an explicit
 *  per-endpoint `on_action.auto_accept: true` standing-instruction). This suite
 *  is the **auto-accept byte-equivalence** suite for `create_commitment`:
 *  `baseConfig` sets `on_action.auto_accept: true`, and the commitment-shape
 *  assertions match the retired-drain projection write byte-for-byte. The
 *  REVIEW-by-default path (no `auto_accept` → fire the compiled
 *  review-then-approve workflow, held at the gate, no materialize until
 *  approve) is proven in `d-173-reception-drain-single-path.test.ts`. The
 *  non-`create_commitment` effects (`mark_resolved` / `fire_recipe`) route
 *  through `applyEffect` regardless of auto-accept, unchanged. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMITMENT_STATEMENT_MAX,
  formatApprovalLinkConsumedOutcome,
  type ApprovalLinkActionKind,
  type ApprovalLinkConfig,
  type ApprovalLinkConsumedOutcome,
} from '@recued/contracts';
import { ensureReceptionSchema } from '../storage/reception-store.js';
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
  deriveApprovalIntentPiiKeyFromSubDek,
  sealApprovalIntentPiiField,
} from '../ports/reception/approval-pii.js';
import { computeBearerHmac, deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import { createApprovalLinkSubmissionProcessor } from '../ports/reception/processors/approval-link-processor.js';
import type { ReceptionSubmissionProcessor } from '../ports/reception/reception-drain.js';

const NOW = 1_700_000_000_000;
const PEPPER = deriveReceptionPepper(Buffer.alloc(32, 0xc4));
const APPROVAL_KEY = deriveApprovalIntentPiiKeyFromSubDek(Buffer.alloc(32, 0x5a));

interface Env {
  registry: PublicEndpointRegistryStore;
  intentStore: ApprovalIntentStore;
  workStore: WorkEntityStore;
}

type ConfigOverrides = Omit<Partial<ApprovalLinkConfig>, 'on_action'> & {
  readonly on_action?: Partial<ApprovalLinkConfig['on_action']>;
};

const buildEnv = (): Env => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  ensureWorkEntitySchema(db);
  const workStore = createWorkEntityStore(db);
  autoRegisterRecuedBuiltinSources(workStore, NOW);
  return {
    registry: createPublicEndpointRegistryStore(db),
    intentStore: createReceptionApprovalIntentStore(db),
    workStore,
  };
};

const defaultOptionsFor = (
  action_kind: ApprovalLinkActionKind,
): ApprovalLinkConfig['options'] => {
  if (action_kind === 'confirm_attendance') {
    return [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];
  }
  if (action_kind === 'pick_time') {
    return [
      { id: 'opt_a', label: '9am Mon' },
      { id: 'opt_b', label: '2pm Tue' },
    ];
  }
  return undefined;
};

const hasOwn = (o: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, key);

const baseConfig = (over: ConfigOverrides = {}): ApprovalLinkConfig => {
  const action_kind = over.action_kind ?? 'approve_wording';
  const options = hasOwn(over, 'options')
    ? over.options
    : defaultOptionsFor(action_kind);
  return {
    display_name: over.display_name ?? 'Mary',
    action_kind,
    prompt: over.prompt ?? 'Please approve the wording.',
    context_raw: over.context_raw ?? { summary: 'D-149 approval drain.' },
    ...(options !== undefined ? { options } : {}),
    visitor_field_constraints: over.visitor_field_constraints ?? {
      name: 'optional',
      email: 'optional',
    },
    expiry_days: over.expiry_days ?? 7,
    on_action: {
      target_id: 'target-1',
      on_approve_action: 'create_commitment',
      // D-173 P3 § A.7 — auto-accept by default so `create_commitment` cases
      // materialize straight through (the old-drain behavior); the assertions
      // below match the retired drain byte-for-byte. A per-test `over.on_action`
      ...over.on_action,
    },
    ...(over.success_message !== undefined ? { success_message: over.success_message } : {}),
    ...(over.submit_button_label !== undefined ? { submit_button_label: over.submit_button_label } : {}),
    ...(over.template_ref !== undefined ? { template_ref: over.template_ref } : {}),
    ...(over.visitor_receipt !== undefined ? { visitor_receipt: over.visitor_receipt } : {}),
  };
};

const seedEndpoint = (
  env: Env,
  endpoint_id: string,
  metadata: ApprovalLinkConfig | Readonly<Record<string, unknown>>,
  opts: { enabled?: boolean; created_at?: number; intent_id?: string } = {},
): void => {
  env.registry.create({
    endpoint_id,
    kind: 'approval_link',
    packet_declaration: {
      packet_kind: 'approval_link_packet',
      source_query_ref: {
        kind: 'reception_approval_intent',
        intent_id: opts.intent_id ?? endpoint_id,
      },
    },
    bearer_secret_hmac: computeBearerHmac('tok', PEPPER),
    created_at: opts.created_at ?? NOW - 1000,
    created_by_client_id: 'inst-1',
    expires_at: null,
    long_lived_acknowledged_at: NOW - 1000,
    metadata: metadata as Readonly<Record<string, unknown>>,
  });
  if (opts.enabled ?? true) env.registry.enable(endpoint_id, NOW);
};

const consumeIntent = async (
  env: Env,
  input: {
    endpoint_id: string;
    intent_id: string;
    action_kind: ApprovalLinkActionKind;
    target_id: string | null;
    outcome: ApprovalLinkConsumedOutcome;
    visitor_email?: string;
    key?: Uint8Array;
  },
): Promise<void> => {
  env.intentStore.create({
    intent_id: input.intent_id,
    endpoint_id: input.endpoint_id,
    action_kind: input.action_kind,
    target_id: input.target_id,
    metadata: { seeded_by: 'd-149-drain-approval-test' },
  });
  const key = input.key ?? APPROVAL_KEY;
  const outcomeWire = formatApprovalLinkConsumedOutcome(input.outcome);
  const outcome_encrypted = await sealApprovalIntentPiiField({
    key,
    endpoint_id: input.endpoint_id,
    intent_id: input.intent_id,
    field: 'outcome',
    plaintext: outcomeWire,
  });
  const visitor_email_encrypted = await sealApprovalIntentPiiField({
    key,
    endpoint_id: input.endpoint_id,
    intent_id: input.intent_id,
    field: 'visitor_email',
    plaintext: input.visitor_email ?? null,
  });
  const res = env.intentStore.tryConsume({
    intent_id: input.intent_id,
    endpoint_id: input.endpoint_id,
    now: NOW - 500,
    source_ip_hash: 'ip-hash',
    visitor_email_encrypted,
    visitor_name_encrypted: null,
    outcome_encrypted: outcome_encrypted!,
    metadata_patch: { outcome_kind: input.outcome.kind },
  });
  expect(res.ok).toBe(true);
};

const consumeForConfig = async (
  env: Env,
  input: {
    endpoint_id: string;
    intent_id: string;
    config: ApprovalLinkConfig;
    outcome: ApprovalLinkConsumedOutcome;
    visitor_email?: string;
    key?: Uint8Array;
  },
): Promise<void> => {
  await consumeIntent(env, {
    endpoint_id: input.endpoint_id,
    intent_id: input.intent_id,
    action_kind: input.config.action_kind,
    target_id: input.config.on_action.target_id,
    outcome: input.outcome,
    visitor_email: input.visitor_email,
    key: input.key,
  });
};

const processorFor = (
  env: Env,
  extra: Partial<Parameters<typeof createApprovalLinkSubmissionProcessor>[0]> = {},
): ReceptionSubmissionProcessor =>
  createApprovalLinkSubmissionProcessor({
    registryStore: env.registry,
    intentStore: env.intentStore,
    workEntityStore: env.workStore,
    getApprovalIntentPiiKey: () => APPROVAL_KEY,
    now: () => NOW,
    // D-210 Phase C — `on_action.auto_accept` is retired, so a
    // `create_commitment` outcome DISPATCHES for review rather than
    // materializing. Wire the seam by default or every such intent would sit
    // PENDING and the drain-loop assertions below would pass vacuously.
    fireReceptionWorkflow: async () => ({ dispatched: true }),
    ...extra,
  });

const commitmentId = (intent_id: string): string => `reception_${intent_id}`;

const suppressWarn = (): void => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
};

describe('approval_link drain - materialization and effects', () => {
  let env: Env;

  beforeEach(() => {
    env = buildEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DISPATCHES an inbound peer_received commitment for review — and materializes nothing', async () => {
    // ⚠ D-210 Phase C RE-AIMED. This asserted the auto-accept MATERIALIZE. With
    // `on_action.auto_accept` retired, an affirmative outcome dispatches the
    // review-then-approve workflow and the commitment is written only when the
    // owner approves it in the inbox. The projection SHAPE assertions moved
    // with it — they now describe the dispatched payload.
    const config = baseConfig();
    seedEndpoint(env, 'ep-approve', config);
    await consumeForConfig(env, {
      endpoint_id: 'ep-approve',
      intent_id: 'intent-approve',
      config,
      outcome: { kind: 'approve' },
    });

    const fired: Array<{ payload: Record<string, unknown> }> = [];
    const res = await processorFor(env, {
      fireReceptionWorkflow: async (d) => {
        fired.push(d as { payload: Record<string, unknown> });
        return { dispatched: true };
      },
    }).drainOnce({ now: NOW, limit: 50 });
    expect(res).toEqual({ processed: 1, failed: 0 });

    const intent = env.intentStore.findById('intent-approve')!;
    expect(intent.processing_outcome).toBe('processed');

    // ⛔ NOTHING materialized — the whole point of the retire.
    expect(env.workStore.readCommitment(commitmentId('intent-approve'))).toBeNull();

    expect(fired).toHaveLength(1);
    const p = fired[0]!.payload;
    expect(p.top_tier_kind).toBe('commitment');
    expect(p.id).toBe(commitmentId('intent-approve'));
    // `body` is the statement source the projection clamps into `statement`
    // on approve — the outcome leads it, which is the shaping the deleted
    // materialize test used to check on the written row.
    expect(String(p.body)).toContain('Approved');
    expect(p.metadata).toMatchObject({
      reception_approval_intent_id: 'intent-approve',
      reception_endpoint_id: 'ep-approve',
      reception_action_kind: 'approve_wording',
    });
    // The sealed visitor email never rides the queryable payload.
    expect(p.metadata).not.toHaveProperty('visitor_email');
    // `direction` / `derivation` are the PROJECTION's to choose on approve —
    // deliberately not in the dispatched payload, so a visitor-influenced
    // field can never set them.
    expect(Object.hasOwn(p, 'direction')).toBe(false);
    expect(Object.hasOwn(p, 'derivation')).toBe(false);
  });

  it('marks a non-affirmative create_commitment outcome processed without creating a commitment', async () => {
    const config = baseConfig();
    seedEndpoint(env, 'ep-reject', config);
    await consumeForConfig(env, {
      endpoint_id: 'ep-reject',
      intent_id: 'intent-reject',
      config,
      outcome: { kind: 'reject', comment: 'needs changes' },
    });

    const res = await processorFor(env).drainOnce({ now: NOW, limit: 50 });
    expect(res).toEqual({ processed: 1, failed: 0 });
    expect(env.intentStore.findById('intent-reject')!.processing_outcome).toBe('processed');
    expect(env.workStore.readCommitment(commitmentId('intent-reject'))).toBeNull();
  });

  it('leads the dispatched statement with the response so a long prompt cannot clamp it away', async () => {
    // ⚠ D-210 Phase C RE-AIMED: asserted on the materialized commitment; now on
    // the dispatched payload's `body` (the projection's statement source).
    const config = baseConfig({
      prompt: `${'Please review this very detailed approval request. '.repeat(12)}End.`,
    });
    expect(config.prompt.length).toBeGreaterThan(COMMITMENT_STATEMENT_MAX);
    seedEndpoint(env, 'ep-long-prompt', config);
    await consumeForConfig(env, {
      endpoint_id: 'ep-long-prompt',
      intent_id: 'intent-long-prompt',
      config,
      outcome: { kind: 'approve' },
    });

    const fired: Array<{ payload: Record<string, unknown> }> = [];
    await processorFor(env, {
      fireReceptionWorkflow: async (d) => {
        fired.push(d as { payload: Record<string, unknown> });
        return { dispatched: true };
      },
    }).drainOnce({ now: NOW, limit: 50 });

    // The outcome leads, so clamping to COMMITMENT_STATEMENT_MAX on approve
    // cannot cut it away.
    expect(String(fired[0]!.payload.body).startsWith('Approved')).toBe(true);
  });

  it('routes mark_resolved through applyEffect with decrypted outcome context and no commitment', async () => {
    const config = baseConfig({
      on_action: { on_approve_action: 'mark_resolved', target_id: 'approval-123' },
    });
    seedEndpoint(env, 'ep-mark', config);
    await consumeForConfig(env, {
      endpoint_id: 'ep-mark',
      intent_id: 'intent-mark',
      config,
      outcome: { kind: 'approve' },
      visitor_email: 'visitor@example.com',
    });
    const applyEffect = vi.fn();

    const res = await processorFor(env, { applyEffect }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 1, failed: 0 });
    expect(applyEffect).toHaveBeenCalledTimes(1);
    expect(applyEffect.mock.calls[0]![0]).toMatchObject({
      endpoint_id: 'ep-mark',
      intent_id: 'intent-mark',
      action_kind: 'approve_wording',
      on_approve_action: 'mark_resolved',
      target_id: 'approval-123',
      outcome: 'approve',
      affirmative: true,
      visitor_email: 'visitor@example.com',
    });
    expect(env.intentStore.findById('intent-mark')!.processing_outcome).toBe('processed');
    expect(env.workStore.listCommitments()).toHaveLength(0);
  });

  it('routes fire_recipe through applyEffect', async () => {
    // ⚠ D-210 Phase C — `triggered_recipe_id` is RETIRED, so `fire_recipe` no
    // longer names a recipe. What survives is the ROUTING claim: a
    // `fire_recipe` outcome goes to `applyEffect` rather than materializing a
    // commitment. ⛔ `applyEffect` is itself never bound in production
    // (`wire-reception-substrate.ts`: the notify + triggered_recipe /
    // applyEffect seams "are intentionally left unwired here"), so BOTH halves
    // of this path are inert today — see the handover.
    const config = baseConfig({
      action_kind: 'answer_question',
      prompt: 'What should we do next?',
      on_action: {
        on_approve_action: 'fire_recipe',
        target_id: 'question-123',
      },
    });
    seedEndpoint(env, 'ep-recipe', config);
    await consumeForConfig(env, {
      endpoint_id: 'ep-recipe',
      intent_id: 'intent-recipe',
      config,
      outcome: { kind: 'answer', answer: 'Ship it.' },
    });
    const applyEffect = vi.fn();

    const res = await processorFor(env, { applyEffect }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 1, failed: 0 });
    expect(applyEffect).toHaveBeenCalledTimes(1);
    expect(applyEffect.mock.calls[0]![0]).toMatchObject({
      on_approve_action: 'fire_recipe',
      target_id: 'question-123',
      outcome: 'answer:Ship it.',
      affirmative: true,
    });
    expect(env.intentStore.findById('intent-recipe')!.processing_outcome).toBe('processed');
  });

  it('leaves unwired mark_resolved pending without spending drain budget', async () => {
    const config = baseConfig({ on_action: { on_approve_action: 'mark_resolved' } });
    seedEndpoint(env, 'ep-unwired', config);
    await consumeForConfig(env, {
      endpoint_id: 'ep-unwired',
      intent_id: 'intent-unwired',
      config,
      outcome: { kind: 'approve' },
    });
    const getApprovalIntentPiiKey = vi.fn(() => {
      throw new Error('should not decrypt an unwired effect row');
    });

    const res = await processorFor(env, { getApprovalIntentPiiKey }).drainOnce({
      now: NOW,
      limit: 1,
    });

    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(getApprovalIntentPiiKey).not.toHaveBeenCalled();
    expect(env.intentStore.findById('intent-unwired')!.processing_outcome).toBe('pending');

    const budgetEnv = buildEnv();
    const createConfig = baseConfig();
    const markConfig = baseConfig({ on_action: { on_approve_action: 'mark_resolved' } });
    seedEndpoint(budgetEnv, 'ep-create-budget', createConfig, { created_at: NOW - 2000 });
    seedEndpoint(budgetEnv, 'ep-mark-budget', markConfig, { created_at: NOW - 1000 });
    await consumeForConfig(budgetEnv, {
      endpoint_id: 'ep-mark-budget',
      intent_id: 'intent-mark-budget',
      config: markConfig,
      outcome: { kind: 'approve' },
    });
    await consumeForConfig(budgetEnv, {
      endpoint_id: 'ep-create-budget',
      intent_id: 'intent-create-budget',
      config: createConfig,
      outcome: { kind: 'approve' },
    });

    const budgetRes = await processorFor(budgetEnv).drainOnce({ now: NOW, limit: 1 });
    expect(budgetRes).toEqual({ processed: 1, failed: 0 });
    expect(budgetEnv.intentStore.findById('intent-mark-budget')!.processing_outcome).toBe('pending');
    expect(budgetEnv.intentStore.findById('intent-create-budget')!.processing_outcome).toBe('processed');
    // D-210 Phase C — the create_commitment intent DISPATCHES for review; the
    // commitment row appears only on approve. What this test is about is the
    // BUDGET, and that is asserted above.
    expect(budgetEnv.workStore.readCommitment(commitmentId('intent-create-budget'))).toBeNull();
  });

  it('fails consumed intents whose registry metadata is not a valid ApprovalLinkConfig', async () => {
    seedEndpoint(env, 'ep-bad-config', { not_a_config: true });
    await consumeIntent(env, {
      endpoint_id: 'ep-bad-config',
      intent_id: 'intent-bad-config',
      action_kind: 'approve_wording',
      target_id: 'target-1',
      outcome: { kind: 'approve' },
    });

    const res = await processorFor(env).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 0, failed: 1 });
    expect(env.intentStore.findById('intent-bad-config')!.processing_outcome).toBe('failed');
  });

  it('fails consumed intents whose outcome cannot be decrypted', async () => {
    suppressWarn();
    const config = baseConfig();
    seedEndpoint(env, 'ep-wrong-key', config);
    await consumeForConfig(env, {
      endpoint_id: 'ep-wrong-key',
      intent_id: 'intent-wrong-key',
      config,
      outcome: { kind: 'approve' },
    });
    const wrongKey = deriveApprovalIntentPiiKeyFromSubDek(Buffer.alloc(32, 0x99));

    const res = await processorFor(env, {
      getApprovalIntentPiiKey: () => wrongKey,
    }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 0, failed: 1 });
    expect(env.intentStore.findById('intent-wrong-key')!.processing_outcome).toBe('failed');
  });

  it('leaves consumed intents pending when the approval PII key is unavailable', async () => {
    suppressWarn();
    const config = baseConfig();
    seedEndpoint(env, 'ep-locked', config);
    await consumeForConfig(env, {
      endpoint_id: 'ep-locked',
      intent_id: 'intent-locked',
      config,
      outcome: { kind: 'approve' },
    });

    const res = await processorFor(env, {
      getApprovalIntentPiiKey: () => {
        throw new Error('vault locked');
      },
    }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 0, failed: 0 });
    expect(env.intentStore.findById('intent-locked')!.processing_outcome).toBe('pending');
  });

  it('fails a mark_resolved intent when applyEffect throws', async () => {
    suppressWarn();
    const config = baseConfig({
      on_action: { on_approve_action: 'mark_resolved', target_id: 'approval-throw' },
    });
    seedEndpoint(env, 'ep-effect-throws', config);
    await consumeForConfig(env, {
      endpoint_id: 'ep-effect-throws',
      intent_id: 'intent-effect-throws',
      config,
      outcome: { kind: 'approve' },
    });
    const applyEffect = vi.fn(() => {
      throw new Error('effect failed');
    });

    const res = await processorFor(env, { applyEffect }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 0, failed: 1 });
    expect(applyEffect).toHaveBeenCalledTimes(1);
    expect(env.intentStore.findById('intent-effect-throws')!.processing_outcome).toBe('failed');
    expect(env.workStore.listCommitments()).toHaveLength(0);
  });

  it('drains consumed intents for never-enabled endpoints and endpoints revoked after consume', async () => {
    const disabledConfig = baseConfig();
    const revokedConfig = baseConfig();
    seedEndpoint(env, 'ep-disabled', disabledConfig, { enabled: false, created_at: NOW - 2000 });
    seedEndpoint(env, 'ep-revoked', revokedConfig, { created_at: NOW - 1000 });
    await consumeForConfig(env, {
      endpoint_id: 'ep-disabled',
      intent_id: 'intent-disabled',
      config: disabledConfig,
      outcome: { kind: 'approve' },
    });
    await consumeForConfig(env, {
      endpoint_id: 'ep-revoked',
      intent_id: 'intent-revoked',
      config: revokedConfig,
      outcome: { kind: 'approve' },
    });
    env.registry.revoke({
      endpoint_id: 'ep-revoked',
      now: NOW,
      reason: 'revoked after consume',
    });

    const res = await processorFor(env).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 2, failed: 0 });
    expect(env.intentStore.findById('intent-disabled')!.processing_outcome).toBe('processed');
    expect(env.intentStore.findById('intent-revoked')!.processing_outcome).toBe('processed');
    // D-210 Phase C — both DISPATCH for review rather than materializing. What
    // this test is about is that neither is stranded by the endpoint's later
    // disable/revoke, and `processed` proves that.
    expect(env.workStore.readCommitment(commitmentId('intent-disabled'))).toBeNull();
    expect(env.workStore.readCommitment(commitmentId('intent-revoked'))).toBeNull();
  });

  it('fires notify after a create_commitment dispatch with the outcome summary', async () => {
    const config = baseConfig();
    seedEndpoint(env, 'ep-notify', config);
    await consumeForConfig(env, {
      endpoint_id: 'ep-notify',
      intent_id: 'intent-notify',
      config,
      outcome: { kind: 'approve' },
    });
    const notify = vi.fn();

    const res = await processorFor(env, { notify }).drainOnce({ now: NOW, limit: 50 });

    expect(res).toEqual({ processed: 1, failed: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      kind: 'approval_link',
      endpoint_id: 'ep-notify',
      intent_id: 'intent-notify',
      action_kind: 'approve_wording',
      on_approve_action: 'create_commitment',
      affirmative: true,
      outcome_summary: 'Approved',
      // D-210 Phase C — no `created_commitment_id`: nothing materializes at
      // dispatch time, so the notice names the intent + its outcome only.
      // A commitment id exists only after the owner approves.
    });
  });

  it('does not re-drain processed intents and keeps committed work complete when notify fails', async () => {
    suppressWarn();
    const config = baseConfig();
    seedEndpoint(env, 'ep-notify-throws', config);
    await consumeForConfig(env, {
      endpoint_id: 'ep-notify-throws',
      intent_id: 'intent-notify-throws',
      config,
      outcome: { kind: 'approve' },
    });
    const notify = vi.fn(() => {
      throw new Error('channel down');
    });
    const processor = processorFor(env, { notify });

    const first = await processor.drainOnce({ now: NOW, limit: 50 });
    const second = await processor.drainOnce({ now: NOW, limit: 50 });

    expect(first).toEqual({ processed: 1, failed: 0 });
    expect(second).toEqual({ processed: 0, failed: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
    // ⚠ D-210 Phase C RE-AIMED. The claim was "a thrown notify never undoes the
    // committed MATERIALIZATION". Nothing materializes at dispatch any more, so
    // the equivalent claim is: a thrown notify never undoes the DISPATCH — the
    // intent stays `processed`, the hold is live in the inbox, and the drain
    // does not re-dispatch it (which would double the owner's queue).
    expect(env.intentStore.findById('intent-notify-throws')!.processing_outcome).toBe('processed');
    expect(env.workStore.listCommitments()).toHaveLength(0);
  });
});
