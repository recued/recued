/** WHERE the `mail-send` gate lands, driven through the REAL composition root.
 *
 *  ⛔⛔ THIS FILE EXISTS BECAUSE A DRIVE THAT SKIPPED `handleExecute` REPORTED
 *  THE OPPOSITE. `records-pack-harness` builds an `ExecutionContext` and calls
 *  the ENGINE directly. Driven there, `send-to-person` sent the mail and THEN
 *  paused on the next step (the records write recording the delivery), which
 *  reads exactly like a gate landing one step too late — "the approval is for
 *  the note, not the letter". That conclusion was wrong.
 *
 *  🔑 WHAT ACTUALLY GATES A SIMPLE-FORM KERNEL OP — established by mutation,
 *  after two wrong guesses that each looked right:
 *
 *  `evaluateAdmission` (`execute-handler.ts:3906`), the per-dispatch admission
 *  probe. It is built in `handleExecute` ONLY, and only for a POLICY_GATED
 *  channel, and it resolves op-risk against the source's stage-trust ceiling.
 *  `mail-send` is `risk_tier: 'write'`; a contracted bearer's ceiling is the
 *  LOW `read` default; write exceeds read ⇒ verdict `'ask'` ⇒ `raiseOnAsk`
 *  throws at the SEND step. An engine-only drive never calls the handler, so
 *  the probe does not exist there and the send simply happens.
 *
 *  ⚠ THE TWO WRONG GUESSES, kept because each is the obvious reading:
 *   1. "the commit Gateway" — removing `commitStore` (exactly what makes
 *      `commitGatewayActive` false) changes NOTHING. There is a narrow fallback
 *      executor at `execute-handler.ts:5010` that runs the SAME probe and
 *      raises the SAME ask. Both branches gate; neutering one raiseOnAsk site
 *      fails exactly one of the two hold tests below, which is how this was
 *      finally localised.
 *   2. "the pre-run static walk" (`gateRecipeAgainstPolicy`) — bypassing it
 *      leaves both holds intact and breaks only the DENY test. The walk owns
 *      the grant axis (`tool_not_in_contract`), not the approval one, for a
 *      simple-form op.
 *
 *  And why records ops still gated under the pack harness, which is what made
 *  the contrast look like "kernel ops are ungated": they are CATALOG-FORM, and
 *  the catalog gateway runs inside the ENGINE (`runStep` →
 *  `runCatalogOperation`), below the handler entirely.
 *
 *  🔑 THE GENERAL RULE, which is why this is pinned rather than fixed and
 *  forgotten: an ABSENT gate and an ADMITTING gate are byte-identical from
 *  inside the run. Only the composition root can tell them apart, so a claim
 *  that something "is not gated" has to be made from there.
 *
 *  What is asserted below is the POSITION of the hold, not merely that a hold
 *  exists — `gated_step_id` must name the SEND, and the dispatcher must never
 *  have run. A test that asserted only "the run paused" would have passed
 *  against the very defect this settles.
 *
 *  ⚠ NOT COVERED HERE, deliberately: `liftOutboundSend`'s `source.actor !==
 *  'user_self'` guard (the `system` exemption, so an unattended run does not
 *  prompt). Applying the lift to every actor leaves this file green — the agent
 *  arm is already held by its ceiling — and IS caught by
 *  `d-157-outbound-send-escalation.test.ts`, verified by running that mutation
 *  against it. Stated so the hole is a decision rather than a gap nobody noticed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type Commit,
  type ContractSnapshot,
  type ExecutionSource,
  type IngredientManifest,
  type RecipeDefinition,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createCommitStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import type { KernelDispatchers } from '@recued/ingredients';

/** A DELEGATED bearer — an external agent holding a contract. Not the owner:
 *  `isDelegatedMcpToken` is `id !== STDIO_MCP_TOKEN_ID`, so the owner's own
 *  stdio client is NOT this and takes the owner path below. */
const agentSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id: 'contract-1',
};

/** The owner, at their own keyboard. Contract-free `user_self` →
 *  `CONTRACT_LESS_TRUST_CEILING = 'admin'` → a `write` relaxes to a silent
 *  admit. This is the arm that makes the comparison mean anything.
 *
 *  ⚠ THE CHANNEL IS `'user'`. `'webclient'` is not a member of the channel
 *  union and `typecheck:tests` refused it — while vitest, which does not
 *  typecheck, ran the arm green over the invalid value. A wrong channel here
 *  would silently pick a different policy row, so this is one of the places the
 *  type IS the test. */
const ownerSource: ExecutionSource = {
  channel: 'user', actor: 'user_self',
  user_id: 'owner-1', client_token_id: 'client-1',
};

const mailSendManifest = {
  slug: 'mail-send', name: 'mail-send', description: 'Test mail-send manifest',
  author: 'recued', kind: 'storage', risk_tier: 'write', version: 1,
  category: 'action', input: {}, output: { message_id: 'message_id' },
} as unknown as IngredientManifest;

/** A kernel WRITE that is not an outbound send. The contrast arm: same owner,
 *  same risk tier, and the owner sails straight through — which is what makes
 *  the mail-send hold a fact about SENDING rather than about writes. */
const noteCreateManifest = {
  slug: 'note-create', name: 'note-create', description: 'Test note-create manifest',
  author: 'recued', kind: 'storage', risk_tier: 'write', version: 1,
  category: 'data', input: {}, output: { note: 'note' },
} as unknown as IngredientManifest;

/** ⛔⛔ A KERNEL DESTRUCTIVE. `core.storage.file.delete` is
 *  `risk_tier: 'destructive'` in `kernel-op-registry.ts`, and the owner's
 *  contract-less ceiling is `admin` — "reads/writes/admin run silent, only
 *  destructive asks" (`op-risk-admission.ts`). So this arm is NOT the owner
 *  sailing through; it is the one risk tier the owner is still asked about,
 *  which is a different fact from the mail-send lift above and needs its own
 *  arm to be said out loud. */
const fileDeleteManifest = {
  slug: 'file-delete', name: 'file-delete', description: 'Test file-delete manifest',
  author: 'recued', kind: 'storage', risk_tier: 'destructive', version: 1,
  category: 'data', input: {}, output: { deleted: 'deleted' },
} as unknown as IngredientManifest;

const snapshot = (allowed_tools: readonly string[]): ContractSnapshot => ({
  contract_id: 'contract-1',
  contract_version: '1',
  allowed_tools,
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_700_000_000_000,
});

/** Two steps, in the order the real recipe runs them: the SEND, then the
 *  bookkeeping write that records it. The second step is what the pack-level
 *  drive saw the hold land on, so it has to be here or the position assertion
 *  has nothing to be wrong about. */
const recipe = {
  recipe_id: 'mail-send-gate-position',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'mail-send gate position fixture',
    description: 'A send followed by the write that records it.',
    author: 'test', supported_platforms: ['test'], tags: ['test', 'mail-send'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'send',
      ingredient: 'mail-send',
      input: {
        sender_mail_instance: 'work', to: ['bob@example.com'],
        subject: 'hi', body: 'hello',
      },
    },
    { id: 'noted', transform: 'default', value: 'recorded' },
  ],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

/** Same shape, a non-send op. */
const noteRecipe = {
  ...recipe,
  recipe_id: 'note-create-owner-control',
  steps: [{ id: 'note', ingredient: 'note-create', input: { body: 'hello' } }],
} as unknown as RecipeDefinition;

const deleteRecipe = {
  ...recipe,
  recipe_id: 'file-delete-owner-destructive',
  steps: [{ id: 'cleanup', ingredient: 'file-delete', input: { record_id: 'file_1' } }],
} as unknown as RecipeDefinition;

/** THE SAME destructive op, reached through a `foreach` — which is how the pack
 *  actually writes it (one delete per attachment). A `foreach` is
 *  continue-on-error, so the question is whether the ask SURVIVES it as a hold
 *  or is swallowed into a per-item `{ ok: false }`. Those two look identical
 *  from the run's `success: true` and differ completely for the owner. */
const deleteEachRecipe = {
  ...recipe,
  recipe_id: 'file-delete-owner-foreach',
  steps: [
    { id: 'ids', transform: 'default', value: ['file_1', 'file_2'], fallback: [] },
    { id: 'cleanup', foreach: '{{step.ids}}', ingredient: 'file-delete',
      input: { record_id: '{{item}}' } },
  ],
} as unknown as RecipeDefinition;

const makeHarness = (withCommitStore = true) => {
  const registry = createManifestRegistry('/nonexistent');
  registry.register(mailSendManifest);
  registry.register(noteCreateManifest);
  registry.register(fileDeleteManifest);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  recipeStore.register(noteRecipe);
  recipeStore.register(deleteRecipe);
  recipeStore.register(deleteEachRecipe);

  const mailSendSpy = vi.fn(async () => ({
    source_id: 'srcid', message_id: '<msgid@example.com>',
    sent_at: 1_700_000_000_000, _id: null, _collection: 'data.mail' as const,
  }));

  /** ⛔ WHERE THE POSITION ACTUALLY LIVES. `handleExecute` reduces the engine's
   *  rich pause to a bare `awaiting_approval: true` marker on its result (see
   *  `durablePauseMarker`), so the result CANNOT answer "which step". The
   *  checkpoint can: it is what the host persists and what resume re-enters at,
   *  so reading `gated_step_id` here reads the thing the system itself uses. */
  const checkpoints: Array<{ gated_step_id?: string }> = [];

  const noteCreateSpy = vi.fn(async () => ({ note: { id: 'note-1', body: 'x' } }));
  const fileDeleteSpy = vi.fn(async () => ({ deleted: true }));

  const deps: ExecuteHandlerDeps = {
    recipeStore,
    executorConfig: {
      manifests: registry,
      kernelDispatchers: {
        mailSend: mailSendSpy, noteCreate: noteCreateSpy, fileDelete: fileDeleteSpy,
      } as unknown as KernelDispatchers,
    },
    baseVault: {},
    instanceId: 'server-test-gate-position',
    ...(withCommitStore
      ? { commitStore: createCommitStore(createInMemoryCollection<Commit>()) }
      : {}),
    checkpointStore: {
      write: vi.fn(async (cp: { gated_step_id?: string }) => { checkpoints.push(cp); }),
    } as unknown as ExecuteHandlerDeps['checkpointStore'],
    // A hold needs its approval anchor too, or it fails as
    // CHECKPOINT_WRITE_FAILED and never reaches `awaiting_approval`.
    auditLog: createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    ),
  };
  return { deps, mailSendSpy, noteCreateSpy, fileDeleteSpy, checkpoints };
};

describe('mail-send — WHERE the gate lands, through the real composition root', () => {
  it('⛔⛔ AN AGENT IS HELD AT THE SEND ITSELF — the mail never leaves', async () => {
    const { deps, mailSendSpy, checkpoints } = makeHarness();
    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: agentSource,
      contract_snapshot: snapshot(['mail-send']),
    }) as unknown as {
      success: boolean; errors: unknown[]; awaiting_approval?: unknown;
    };

    // A hold, not a failure: nothing went wrong, the run is waiting.
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.awaiting_approval).toBe(true);

    // ⛔ THE ASSERTION THIS FILE IS FOR. The hold is on the SEND, not on the
    // step after it. Asserting only that the run paused would pass just as
    // happily against a gate that fired one step late, which is the reading the
    // pack-level drive produced.
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.gated_step_id).toBe('send');

    // …and the corroborating fact, because a gated_step_id is a label and the
    // dispatcher is the truth: nothing was sent.
    expect(mailSendSpy).not.toHaveBeenCalled();
  });

  it('⛔⛔⛔ THE OWNER IS ASKED TOO — sending is lifted ABOVE the risk algebra', async () => {
    // ⛔ THIS ARM REVERSED WHAT I BELIEVED TWICE OVER, so read the provenance
    // rather than the verdict. The checkpoint's own words:
    //
    //   pre_lift_approval: 'never'      ← the risk × ceiling algebra said ADMIT
    //   lift_reason:       'review_send' ← and a LIFT overrode it
    //
    // A contract-free `user_self` takes `CONTRACT_LESS_TRUST_CEILING = 'admin'`,
    // so a `write` relaxes silent — that is why `pre_lift_approval` is 'never'.
    // `liftOutboundSend` then raises it anyway, for `user_self` SPECIFICALLY
    // (`op-risk-admission.ts` — `'system'` is exempt so an unattended digest does
    // not prompt every run, and `'contracted_user'` needs no lift because its LOW
    // ceiling already surfaced it).
    //
    // ⇒ Mail leaving the trust boundary is asked about for EVERYONE, by two
    // different mechanisms: a lift for the owner, the ceiling for an agent.
    const { deps, mailSendSpy, checkpoints } = makeHarness();
    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
      execution_source: ownerSource,
    }) as unknown as { success: boolean; errors: unknown[]; awaiting_approval?: unknown };

    expect(result.errors).toEqual([]);
    expect(result.awaiting_approval).toBe(true);
    expect(mailSendSpy, 'the owner\'s mail does not leave either').not.toHaveBeenCalled();

    const cp = checkpoints[0] as unknown as {
      gated_step_id?: string;
      preflight_context?: {
        reason?: string;
        authorization_provenance?: { pre_lift_approval?: string; lift_reason?: string };
      };
    };
    expect(cp.gated_step_id).toBe('send');
    // ⛔ THE PROVENANCE IS THE ASSERTION. "The owner was asked" is true under the
    // ceiling algebra too (if a ceiling ever tightened), and that would be a
    // different system with an identical-looking result.
    const prov = cp.preflight_context?.authorization_provenance;
    expect(prov?.pre_lift_approval, 'the algebra alone would have admitted').toBe('never');
    expect(prov?.lift_reason).toBe('review_send');
    expect(String(cp.preflight_context?.reason)).toContain('outside your trust boundary');
  });

  it('⛔ CONTROL — the same owner, a non-send write, is NOT asked at all', async () => {
    // Without this the test above says nothing: "the owner was asked" is
    // consistent with an owner who is asked about everything, which would mean
    // the fixture is measuring itself. `note-create` is the same `risk_tier:
    // 'write'`, the same owner, the same harness — and it simply runs.
    //
    // ⇒ the owner's ordinary manual operations ARE ungated; sending is the
    // deliberate exception, which is exactly where the lift sits.
    const { deps, noteCreateSpy, checkpoints } = makeHarness();
    const result = await handleExecute(deps, {
      recipe_id: noteRecipe.recipe_id,
      trigger_source: 'manual',
      execution_source: ownerSource,
    }) as unknown as { success: boolean; errors: unknown[]; awaiting_approval?: unknown };

    expect(result.awaiting_approval, 'no ask for an ordinary write').toBeUndefined();
    expect(checkpoints, 'and nothing was checkpointed').toHaveLength(0);
    expect(noteCreateSpy, 'it just ran').toHaveBeenCalledTimes(1);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('⛔⛔⛔ AND A DESTRUCTIVE HOLDS THE OWNER TOO — the ceiling stops at `admin`', async () => {
    // ⛔ THE ARM THAT CHANGED A PACK. `photo-attribution` ends every send by
    // deleting the temporary delivery copies it just mailed, one
    // `core.storage.file.delete` per attachment. Read off the control test
    // above ("the owner's ordinary manual operations ARE ungated") that step
    // looks free. It is not: `destructive` is the ONE tier above the owner's
    // `admin` ceiling, so tidying up asks — on every send, per attachment.
    //
    // ⚠ Nothing in the pack's own 100-test drive could see this. The pack
    // harness calls the ENGINE, where `evaluateAdmission` does not exist, and
    // its `file-delete` was unstubbed so the step failed inside a `foreach`
    // and was swallowed as a per-item error while the run reported success.
    const { deps, fileDeleteSpy, checkpoints } = makeHarness();
    const result = await handleExecute(deps, {
      recipe_id: deleteRecipe.recipe_id,
      trigger_source: 'manual',
      execution_source: ownerSource,
    }) as unknown as { success: boolean; awaiting_approval?: unknown };

    expect(result.awaiting_approval, 'the owner IS asked to delete').toBeDefined();
    expect(checkpoints.map((c) => c.gated_step_id), 'held at the delete itself')
      .toEqual(['cleanup']);
    expect(fileDeleteSpy, 'and nothing was deleted').not.toHaveBeenCalled();
  });

  it('⛔⛔⛔ AND IN A `foreach` IT IS THE SAME HOLD — not swallowed as a per-item error', async () => {
    const { deps, fileDeleteSpy, checkpoints } = makeHarness();
    const result = await handleExecute(deps, {
      recipe_id: deleteEachRecipe.recipe_id,
      trigger_source: 'manual',
      execution_source: ownerSource,
    }) as unknown as { success: boolean; awaiting_approval?: unknown };

    expect(result.awaiting_approval, 'the loop HOLDS, it does not fail per item').toBeDefined();
    expect(checkpoints.map((c) => c.gated_step_id)).toEqual(['cleanup']);
    expect(fileDeleteSpy).not.toHaveBeenCalled();
  });

  it('⛔⛔ THE HOLD IS THE PRE-RUN WALK, NOT THE COMMIT GATEWAY — no commitStore, same hold', async () => {
    // `commitGatewayActive = runIdentity !== undefined && deps.commitStore !==
    // undefined`. Dropping the store is exactly the condition that turns the
    // commit Gateway OFF — and the hold is unchanged, at the same step.
    //
    // This started as a mutation against the first version of this file, whose
    // header credited the commit Gateway with the gate. The mutation passed,
    // which is what a wrong attribution looks like from inside a green suite:
    // the behaviour was right and the stated reason was not, and a reason
    // nobody checks is how the wrong thing gets "fixed" later.
    const { deps, mailSendSpy, checkpoints } = makeHarness(false);
    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: agentSource,
      contract_snapshot: snapshot(['mail-send']),
    }) as unknown as { awaiting_approval?: unknown };

    expect(result.awaiting_approval).toBe(true);
    expect(checkpoints[0]!.gated_step_id).toBe('send');
    expect(mailSendSpy).not.toHaveBeenCalled();
  });

  it('⛔ and an agent WITHOUT the grant is refused outright, before the ask', async () => {
    // The grant axis and the approval axis are separate, and they compose in
    // this order. Pinned so a future relaxation of one cannot quietly read as
    // the other still holding: an ungranted tool must DENY, not ask.
    const { deps, mailSendSpy } = makeHarness();
    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: agentSource,
      contract_snapshot: snapshot([]),          // mail-send NOT granted
    }) as unknown as {
      success: boolean; errors: Array<{ message?: string }>;
      awaiting_approval?: unknown;
    };

    expect(result.success).toBe(false);
    expect(result.awaiting_approval, 'a denial is not an ask').toBeUndefined();
    // ⚠ A PRE-RUN refusal, not a per-dispatch one: the D-153 policy gate names
    // the step and the reason before the run starts, so an ungranted send never
    // reaches the ask at all. (It is NOT the per-call 'Gateway refused dispatch'
    // message — that is the same gate's in-run arm, reached when the denial
    // depends on resolved arguments.)
    expect(String(result.errors[0]?.message)).toContain('D-153 policy gate denied');
    expect(String(result.errors[0]?.message)).toContain('mail-send');
    expect(String(result.errors[0]?.message)).toContain('not in contract.allowed_tools');
    expect(mailSendSpy).not.toHaveBeenCalled();
  });
});
