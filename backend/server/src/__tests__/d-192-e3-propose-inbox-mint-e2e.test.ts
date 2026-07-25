/** D-192 email flagship E3 — the FULL propose → gateway hold → inbox
 *  approve → mint path, end to end, with NO shortcuts.
 *
 *  The E1/E3 extraction+funnel legs are covered by
 *  `d-192-e3-commitment-extraction-funnel.test.ts` (which stubs the `fire`).
 *  This test closes the LAST leg the F1 tests never exercised (they mocked
 *  the fire): the funnel's `fire` is the REAL `handleExecute`, so the
 *  kernel `commitment-propose` op is genuinely HELD at the D-157 gate (via
 *  `liftCommitmentProposal`, which lifts EVERY actor), surfaced in the
 *  reception inbox, approved-with-editable-args, and — on resume — MINTS a
 *  `data_commitment` carrying the `mail` evidence blob + the owner's edits.
 *
 *  It is the deterministic (LLM-free) analog of the seeded live smoke, and
 *  the first e2e proof that a `commitment-propose` hold actually MINTS on
 *  approval rather than re-lifting forever (the review-then-approve resume
 *  goes PAST the gate because the ask was answered `approve`).
 *
 *  Harness modeled on `d-173-capstone-full-path-e2e.test.ts`, stripped of
 *  the pack/catalog/connection-profile half: a kernel op holds via op-risk
 *  alone (no connection profile, no catalog decompose). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  Checkpoint,
  Commit,
  CommitmentMailEvidence,
  ExecutionSource,
} from '@recued/contracts';
import { createPreflightAnswerHandler } from '@recued/gateway';
import {
  createAuditLogStore,
  createCheckpointStore,
  createCommitStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';

import {
  COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
  COMMITMENT_EVIDENCE_PROPOSAL_RECIPE,
  COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
} from '../commitment-evidence-capture.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createRecipeStore } from '../recipe-store.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createEventBus } from '../events/bus.js';
import { createReceptionInboxSubviewStore } from '../storage/reception-inbox-subview-store.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { composeReceptionInboxDeps } from '../composition/bin/wire-reception-inbox-deps.js';
import {
  handleReceptionInboxApprove,
  handleReceptionInboxList,
} from '../reception-inbox-handler.js';
import type { ServerExecutorConfig } from '../server-executor.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ADMIN = { instance_id: 'instance-admin' };
const SUBJECT = 'anna@acme.com';

/** The `mail` evidence + payload the E3 funnel composes for an inbound
 *  extracted commitment (see `runCommitmentProposalFunnel`). */
const mailEvidence: CommitmentMailEvidence = {
  kind: 'mail',
  full_target_id: 'hubspot_email_conn_e1',
  source: 'engagement_email',
  actor_email: SUBJECT,
  snippet: 'send the revised SOW by Friday',
  confidence: 0.82,
  source_at: NOW - 3_600_000,
  captured_at: NOW,
};
const proposalPayload: Record<string, unknown> = {
  direction: 'inbound',
  statement: 'send the revised SOW by Friday',
  derivation: 'evidence_captured',
  promised_at: NOW - 3_600_000,
  evidence_blob: [mailEvidence],
  counterparty_contact_id: SUBJECT,
};

interface Env {
  db: Database.Database;
  workStore: WorkEntityStore;
  checkpointStore: ReturnType<typeof createCheckpointStore>;
  auditLog: ReturnType<typeof createAuditLogStore>;
  executeDeps: ExecuteHandlerDeps;
  inboxDeps: ReturnType<typeof composeReceptionInboxDeps>;
  fire: (payload: Record<string, unknown>, run_id: string) => Promise<unknown>;
}

const buildEnv = (): Env => {
  const db = new Database(':memory:');
  const localManifestStore = createLocalManifestStore(db);
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );
  const checkpointStore = createCheckpointStore(createInMemoryCollection<Checkpoint>());

  // Work-entity store + builtin Sources — the mint destination.
  ensureWorkEntitySchema(db);
  const workStore = createWorkEntityStore(db);
  autoRegisterRecuedBuiltinSources(workStore, NOW);
  const dispatchers = createWorkEntityDispatchers({
    store: workStore,
    resolver: createWorkEntityResolver(workStore),
    now: () => NOW,
  });

  // The executor config: the real kernel manifests (so `commitment-propose`
  // resolves as a write op) + the work-entity `commitmentCreate` dispatcher
  // (the kernel adapter routes BOTH `commitment-create` and
  // `commitment-propose` through it — the gate is the only difference).
  const manifestBySlug = new Map(KERNEL_MANIFESTS.map((m) => [m.slug, m]));
  const executorConfig = {
    manifests: {
      get: (slug: string) => manifestBySlug.get(slug),
      slugs: () => [...manifestBySlug.keys()],
    },
    kernelDispatchers: { commitmentCreate: dispatchers.commitmentCreate },
  } as unknown as ServerExecutorConfig;

  const recipeStore = createRecipeStore('/nonexistent-d192-e3-recipes');
  recipeStore.register(COMMITMENT_EVIDENCE_PROPOSAL_RECIPE);

  // The REAL preflight resumer + on_answer + a capturing notification-block
  // stand-in (the capstone pattern): the block persists the ask's
  // `(kind, payload)` and dispatches to `on_answer` when the answer arrives.
  let executeDeps: ExecuteHandlerDeps;
  const resumer = createPreflightResumer({
    getExecuteDeps: () => executeDeps,
    auditLog,
  });
  const onAnswer = createPreflightAnswerHandler({ checkpointStore, resumer });
  let pendingAsk: { kind: string; payload: Record<string, unknown> } | undefined;
  const preflightNotifier = {
    ask: async (
      _message: unknown,
      _options: unknown,
      handler: { kind: string; payload: Record<string, unknown> },
    ) => {
      pendingAsk = { kind: handler.kind, payload: handler.payload };
      return { ask_id: 'ask-d192-e3' };
    },
    registerAskHandler: () => undefined,
  } as unknown as ExecuteHandlerDeps['preflightNotifier'];

  executeDeps = {
    recipeStore,
    executorConfig,
    baseVault: {},
    auditLog,
    checkpointStore,
    // The commit Gateway (which raises the `ask`/hold on an op-risk lift) only
    // wraps the executor when a commitStore is present — load-bearing for the
    // kernel commitment-propose HOLD.
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    preflightNotifier,
  };

  const inboxDeps = composeReceptionInboxDeps({
    auditLog,
    checkpointStore,
    localManifestStore,
    eventBus: createEventBus(),
    subviewStore: createReceptionInboxSubviewStore(db),
    submitAnswer: async (ask_id, option_id) => {
      if (pendingAsk === undefined || ask_id !== 'ask-d192-e3') return;
      await onAnswer(pendingAsk.payload, { ask_id, option: option_id } as never);
    },
    workEntityStore: workStore,
    now: () => NOW,
  });

  const source: ExecutionSource = {
    channel: 'reactive',
    actor: 'system',
    event_kind: COMMITMENT_EVIDENCE_CAPTURE_EVENT_KIND,
    source_recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE_ID,
  };
  const fire = (payload: Record<string, unknown>, run_id: string): Promise<unknown> =>
    handleExecute(
      executeDeps,
      {
        recipe: COMMITMENT_EVIDENCE_PROPOSAL_RECIPE as unknown as Record<string, unknown>,
        trigger_source: 'reactive',
        execution_source: source,
        context: { event: { payload } },
      } as never,
      { run_id } as never,
    );

  return { db, workStore, checkpointStore, auditLog, executeDeps, inboxDeps, fire };
};

/** Raw read of every minted commitment row (the dispatcher generates the id
 *  internally, so query the table rather than `readCommitment(id)`). */
const listCommitments = (db: Database.Database): Array<Record<string, unknown>> =>
  db.prepare('SELECT * FROM data_commitment').all() as Array<Record<string, unknown>>;

describe('D-192 E3 — propose → gateway hold → inbox approve → mint (full path)', () => {
  let env: Env;
  beforeEach(() => {
    env = buildEnv();
  });
  afterEach(() => {
    env.db.close();
  });

  it('holds the commitment-propose op at the D-157 gate — no mint yet', async () => {
    const result = (await env.fire(proposalPayload, 'run-d192-e3-1')) as {
      success: boolean;
      awaiting_approval?: unknown;
    };
    // The commitment-proposal lift → PreflightRequiredSignal → held.
    expect(result.success).toBe(false);
    expect(result.awaiting_approval).toBeDefined();
    // Nothing minted while held.
    expect(listCommitments(env.db)).toHaveLength(0);

    const checkpoints = await env.checkpointStore.list();
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.gated_step_id).toBe('propose_commitment');
    // A simple-form kernel op-step records the BACKING SLUG (no catalog
    // `surface_operation_key` ⇒ no fully-qualified `operation_id`).
    expect(checkpoints[0]!.approved_target?.ingredient_slug).toBe('commitment-propose');

    const held = await env.auditLog.get('run-d192-e3-1');
    expect(held!.commit_status).toBe('awaiting_approval');
    expect(held!.checkpoint_id).toBe(checkpoints[0]!.checkpoint_id);
  });

  it('surfaces the held proposal in the reception inbox with the editable-args allowlist', async () => {
    await env.fire(proposalPayload, 'run-d192-e3-2');
    const list = await handleReceptionInboxList(env.inboxDeps!.receptionInboxDeps, {}, ADMIN);
    expect(list.items).toHaveLength(1);
    const item = list.items[0]!;
    // The held op's identity is the backing slug (see the hold test).
    expect(item.operation_id).toBe('commitment-propose');
    // The kernel commitment-evidence allowlist (statement / deadline /
    // direction / counterparty) — the evidence blob is deliberately NOT
    // editable. This is the Fix-#2 proof: the allowlist now resolves for the
    // backing-slug identity (was empty ⇒ every edit rejected).
    expect(item.arg_schema.fields.map((f) => f.key).sort()).toEqual([
      'counterparty_contact_id',
      'direction',
      'promised_for_at',
      'statement',
    ]);
    // ⛔ THIS ASSERTION WAS INVERTED, and its old comment was WRONG ABOUT THE
    // MECHANISM. It read `expect(item.args).toEqual({})` under the claim that
    // *"the list PII-redacts the args (D-173 I-3)"*. Nothing redacts
    // `item.args` — it is `resolved.args` verbatim, and the `form_response`
    // arm deliberately ADDS the sealed visitor email to it. The `{}` here was
    // an ARTIFACT: kernel ops dispatch through the engine's simple-form branch,
    // which recorded nothing under the gated step id, so this path had no args
    // to show rather than args withheld.
    //
    // The contract already assigned the two roles: `InboxItem.args` is
    // *"concrete values — what the held op will dispatch"*, and
    // `InboxItem.preview` is the field carrying the I-3 obligation (*"REDACTED
    // … never carries un-revealed PII"*). The owner ruled the same way: for a
    // custom intake there is no knowing in advance which fields someone needs
    // in order to approve, so the list lays them out.
    //
    // 🔑 The tell that the empty prefill was a DEFECT is three lines up — the
    // allowlist offers `counterparty_contact_id` and `statement` as EDITABLE,
    // so the owner was handed edit fields the form could not fill in.
    // `evidence_blob` is deliberately not editable yet appears here anyway,
    // correctly: it is not something to change, it is the reason to decide.
    //
    // Owner-only by construction — `reception.inbox.list` is `requireAdmin`
    // gated and is a WS rpc, which does not bridge to MCP.
    expect(item.args).toEqual({
      counterparty_contact_id: 'anna@acme.com',
      derivation: 'evidence_captured',
      direction: 'inbound',
      evidence_blob: [
        {
          actor_email: 'anna@acme.com',
          captured_at: 1_700_000_000_000,
          confidence: 0.82,
          full_target_id: 'hubspot_email_conn_e1',
          kind: 'mail',
          snippet: 'send the revised SOW by Friday',
          source: 'engagement_email',
          source_at: 1_699_996_400_000,
        },
      ],
      promised_at: 1_699_996_400_000,
      statement: 'send the revised SOW by Friday',
    });
    // The card itself stays redacted — that is where I-3 actually lives.
    expect(JSON.stringify(item.preview)).not.toContain('@');
    expect(JSON.stringify(item.preview)).not.toContain('SOW');
  });

  it('THE CAPSTONE — approve with owner edits → resume MINTS an evidence_captured commitment', async () => {
    await env.fire(proposalPayload, 'run-d192-e3-3');
    const held = (await env.checkpointStore.list())[0]!;
    const holdId = held.checkpoint_id;

    // Owner sets a deadline (absent by design) + refines the statement — both
    // on the allowlist. The evidence blob is immutable (not editable).
    const editedStatement = 'Anna will send the revised SOW by Friday';
    const deadline = NOW + 3 * DAY;
    const approve = await handleReceptionInboxApprove(
      env.inboxDeps!.receptionInboxDeps,
      { hold_id: holdId, edits: { statement: editedStatement, promised_for_at: deadline } },
      ADMIN,
    );
    expect(approve.released).toBe(true);
    expect(approve.edited_keys.sort()).toEqual(['promised_for_at', 'statement']);

    // The resume ran past the gate and MINTED exactly one commitment.
    const rows = listCommitments(env.db);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.derivation).toBe('evidence_captured');
    expect(row.direction).toBe('inbound');
    expect(row.counterparty_contact_id).toBe(SUBJECT);
    // The owner's edits landed (merged off the checkpoint's arg_overrides).
    expect(row.statement).toBe(editedStatement);
    expect(row.promised_for_at).toBe(deadline);
    // The immutable mail evidence blob rode through to the minted row.
    const blob = JSON.parse(row.evidence_blob as string) as CommitmentMailEvidence[];
    expect(blob).toHaveLength(1);
    expect(blob[0]!.kind).toBe('mail');
    expect(blob[0]!.source).toBe('engagement_email');
    expect(blob[0]!.actor_email).toBe(SUBJECT);
    expect(blob[0]!.snippet).toBe('send the revised SOW by Friday'); // NOT the edited statement
  });

  it('a no-edit approve mints the proposal verbatim (byte-identical prefill path)', async () => {
    await env.fire(proposalPayload, 'run-d192-e3-4');
    const held = (await env.checkpointStore.list())[0]!;
    const approve = await handleReceptionInboxApprove(
      env.inboxDeps!.receptionInboxDeps,
      { hold_id: held.checkpoint_id, edits: {} },
      ADMIN,
    );
    expect(approve.released).toBe(true);
    const rows = listCommitments(env.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.statement).toBe('send the revised SOW by Friday');
    // Deadline stays absent (owner didn't set one) — no auto-fill.
    expect(rows[0]!.promised_for_at ?? null).toBeNull();
  });
});
