/** D-209 W3 × D-234 § 234.4o — DOES A WEBHOOK-TRIGGERED RECIPE SEND WITHOUT ASKING?
 *
 *  ⛔⛔ THE QUESTION, AND WHY IT IS NOT ACADEMIC. The outbound-send lift
 *  (`liftOutboundSend`) is scoped to `actor: 'user_self'`; every other actor is
 *  supposed to be held by its trust CEILING instead. That holds for the
 *  unattended triggers — a `system` schedule / reactive dispatch fails closed to
 *  the LOW `read` ceiling, so a `write` send exceeds it and asks. But
 *  `(webhook, anonymous)` is the ONE door permitted an AUTHORED ceiling (D-209 #1
 *  W3), minted `'admin'` at §1.4 — and at `admin` a `write` RELAXES to admit
 *  while the lift, being `user_self`-only, never fires. Nothing re-raises it.
 *
 *  🔑 AND THE PATH IS REAL: `webhook-recipe-consumer.ts` runs an ARBITRARY user
 *  recipe (`recipe_id: claim.recipe_id`) under exactly this source. So a
 *  webhook-triggered recipe containing an outbound send is the shape in question.
 *
 *  ⛔ D-209's OWN STATED PRECONDITION FOR THE CARVE-OUT IS WHAT THIS STRAINS:
 *  "an authored ceiling is admissible only where a MACHINE delivers a payload to
 *  a DETERMINISTIC PATH." A webhook landing in a fixed handler meets that. A
 *  webhook firing an arbitrary recipe does not — the recipe is user content that
 *  can contain any send. The second justification does not transfer either: the
 *  two-sided enrollment approves THE VENDOR DELIVERING PAYLOADS, not whatever a
 *  recipe subsequently decides to do with them.
 *
 *  ✅ RULED AND FIXED (owner, 2026-08-12) — and by the NARROW option, which keeps
 *  D-209's rule intact rather than overriding it: the carve-out survives for a
 *  webhook landing in a DETERMINISTIC HANDLER and drops for one FIRING A RECIPE.
 *  `buildWebhookContractSnapshot` now takes a required `WebhookDispatchPath`, and
 *  the recipe runner passes `'recipe'`, so the authored ceiling never reaches an
 *  arbitrary-recipe dispatch.
 *
 *  ⚠ THE POLICY-LAYER CASES BELOW ARE UNCHANGED BY THAT FIX, AND THAT IS CORRECT.
 *  `resolveTrustCeiling` still honours an authored ceiling WHEN ONE IS PRESENT —
 *  the fix is upstream, at what puts it on the snapshot. So the subject case
 *  still documents "a snapshot carrying `admin` does not hold a send"; what
 *  changed is that the recipe path can no longer produce such a snapshot, which
 *  is asserted at the builder at the bottom of this file. 🔑 Keeping both is the
 *  point: one says what the policy layer does, the other says what can reach it. Drives the REAL `handleExecute`, in the style of
 *  `d-209-webhook-policy-gate.test.ts`, because what is in question is a
 *  composition (ceiling × actor × lift) that no unit of it exhibits alone. */

import { describe, expect, it } from 'vitest';
import {
  OUTBOUND_SEND_INGREDIENT_SLUGS,
  type ContractSnapshot,
  type ExecutionSource,
  type IngredientManifest,
  type RecipeDefinition,
} from '@recued/contracts';

import { buildWebhookContractSnapshot } from '../webhook-contract-snapshot.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);
const DOOR_CONTRACT_ID = 'webhook-door-1';

/** A real member of the closed outbound-send set — the lift's whole purpose. */
// ⛔ RE-POINTED 2026-08-20. This was `notification-send` until that op left the
// outbound set (it authors no recipient — owner ruling). The premise test right
// below is what caught it: its own comment warned that if this slug ever left
// the set, "every assertion below would still pass while measuring nothing".
// `mail-send` is the canonical recipient-authoring send, so the suite measures
// exactly what it always did.
const SEND_SLUG = 'mail-send';

/** The shape `webhook-recipe-consumer.ts` dispatches: `anonymous`, carrying the
 *  claimed trigger row's stamped door contract. */
const webhookSource: ExecutionSource = {
  channel: 'webhook',
  actor: 'anonymous',
  vendor: 'stripe',
  webhook_secret_id: 'ingress-1',
  contract_id: DOOR_CONTRACT_ID,
} as ExecutionSource;

/** The attended owner — the CONTROL. Without it, "the webhook did not ask" is
 *  indistinguishable from "this harness never reaches the approval path at all",
 *  which is the vacuous-negative these drives keep re-learning. */
const ownerSource: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'owner',
  client_token_id: 'client-1',
};

const buildManifest = (slug: string): IngredientManifest => ({
  slug,
  name: slug,
  description: `fixture for ${slug}`,
  author: 'test',
  kind: 'storage',
  risk_tier: 'write',
  version: 1,
  category: 'action',
  input: {},
  output: { data: 'data' },
}) as unknown as IngredientManifest;

const buildRecipe = (recipe_id: string, ingredient: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 60,
  metadata: {
    name: recipe_id,
    description: 'Minimal outbound-send ceiling fixture.',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test', 'policy', 'send'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'call', ingredient, input: {} }],
  output: { sidebar: [] },
}) as RecipeDefinition;

const makeExecuteDeps = (
  recipe: RecipeDefinition,
  manifests: readonly IngredientManifest[],
): ExecuteHandlerDeps => {
  const registry: ManifestRegistry = createManifestRegistry('/nonexistent');
  for (const manifest of manifests) registry.register(manifest);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  return {
    recipeStore,
    executorConfig: { manifests: registry },
    baseVault: {},
    instanceId: 'server-test-1',
  };
};

/** Mirrors `buildWebhookContractSnapshot`. `max_risk_without_approval` is the
 *  D-209 §1.4 minted value — the field `authoredWebhookDoorCeiling` reads, and
 *  ONLY on the source's own door (contract_id match). */
/** ⛔⛔ THE DISCRIMINATOR, AND IT IS NOT "no errors". This harness wires no
 *  checkpoint store, so a preflight hold CANNOT be made durable and
 *  `handleExecute` downgrades it to a fatal `CHECKPOINT_WRITE_FAILED` whose
 *  message says, in as many words, "preflight gate FIRED but no audit log is
 *  wired". So in THIS harness that error IS the proof the gate asked, and its
 *  absence is the proof it did not.
 *
 *  ⚠ My first cut asserted `errors.length === 0` for a hold — copied from the
 *  two-server drive, where a real checkpoint store exists and a pause genuinely
 *  carries no errors. It made the CONTROL fail, which is the only reason the
 *  wrong discriminator was caught rather than silently inverting every verdict
 *  below. A control that cannot fail is not a control. */
const preflightFired = (errors: readonly unknown[]): boolean =>
  errors.some((e) =>
    typeof e === 'object' && e !== null
    && (e as { code?: unknown }).code === 'CHECKPOINT_WRITE_FAILED'
    && /preflight gate fired/i.test(String((e as { message?: unknown }).message ?? '')));

const doorSnapshot = (
  allowed_tools: readonly string[],
  max_risk_without_approval?: 'read' | 'write' | 'admin',
): ContractSnapshot => ({
  contract_id: DOOR_CONTRACT_ID,
  contract_version: '1',
  allowed_tools,
  approval_required: [],
  scope_restrictions: [],
  resolved_at: NOW,
  ...(max_risk_without_approval !== undefined ? { max_risk_without_approval } : {}),
}) as ContractSnapshot;

describe('the outbound-send lift is user_self-scoped — what holds the other actors?', () => {
  it('the send slug under test really is in the closed set', () => {
    // Pins the premise. If `notification-send` ever leaves the set, every
    // assertion below would still pass while measuring nothing.
    expect(OUTBOUND_SEND_INGREDIENT_SLUGS.has(SEND_SLUG)).toBe(true);
  });

  it('CONTROL — the attended owner is asked (the lift fires)', async () => {
    const recipe = buildRecipe('send-owner', SEND_SLUG);
    const result = await handleExecute(
      makeExecuteDeps(recipe, [buildManifest(SEND_SLUG)]),
      { recipe_id: recipe.recipe_id, config: {}, execution_source: ownerSource } as never,
    );
    expect(result.success).toBe(false);
    expect(preflightFired(result.errors ?? [])).toBe(true);
  });

  it('⛔ THE DEFECT, AT THE POLICY LAYER — a snapshot carrying `admin` does NOT hold a send', async () => {
    // THE FINDING. `admin` ceiling relaxes the `write`; the lift is
    // `user_self`-only so nothing re-raises it. The door grants the tool, so
    // Layer-1 ACCESS admits too — which is what separates this from the
    // `tool_not_in_contract` fence asserted below.
    const recipe = buildRecipe('send-webhook', SEND_SLUG);
    const result = await handleExecute(
      makeExecuteDeps(recipe, [buildManifest(SEND_SLUG)]),
      {
        recipe_id: recipe.recipe_id,
        config: {},
        execution_source: webhookSource,
        contract_snapshot: doorSnapshot([SEND_SLUG], 'admin'),
      } as never,
    );
    // ⚠ NOT `success === true` — the fixture ingredient has no adapter, so the
    // dispatch fails at execution either way. The question is only whether the
    // PREFLIGHT GATE fired, and here it does not: the send crossed admission.
    expect(preflightFired(result.errors ?? [])).toBe(false);
  });

  it('…and the LOW-ceiling sibling triggers ARE held — the asymmetry is webhook-only', async () => {
    // A webhook door with NO authored ceiling falls to the contracted LOW
    // default, which is where every other unattended trigger sits. Same actor,
    // same send, opposite outcome — so the difference is the authored ceiling
    // and nothing else.
    const recipe = buildRecipe('send-webhook-lowceiling', SEND_SLUG);
    const result = await handleExecute(
      makeExecuteDeps(recipe, [buildManifest(SEND_SLUG)]),
      {
        recipe_id: recipe.recipe_id,
        config: {},
        execution_source: webhookSource,
        contract_snapshot: doorSnapshot([SEND_SLUG]),
      } as never,
    );
    expect(result.success).toBe(false);
    expect(preflightFired(result.errors ?? [])).toBe(true);
  });

  it('⚠ Layer-1 still fences a tool the door was never granted', async () => {
    // The fence that DOES exist, asserted so the finding is not overstated: the
    // authored ceiling relaxes APPROVAL, never ACCESS. A webhook door can only
    // reach what its allowlist carries — so exploitability turns on whether an
    // owner ever grants a send to a webhook door, which is a separate question
    // from whether the approval gate would hold it.
    const recipe = buildRecipe('send-webhook-ungranted', SEND_SLUG);
    const result = await handleExecute(
      makeExecuteDeps(recipe, [buildManifest(SEND_SLUG)]),
      {
        recipe_id: recipe.recipe_id,
        config: {},
        execution_source: webhookSource,
        contract_snapshot: doorSnapshot(['some-other-ingredient'], 'admin'),
      } as never,
    );
    // Denied, not held — ACCESS refused before APPROVAL was ever consulted.
    expect(result.success).toBe(false);
    expect(preflightFired(result.errors ?? [])).toBe(false);
    expect((result.errors ?? []).length).toBeGreaterThan(0);
  });
});

describe('the fix — an authored ceiling cannot reach an arbitrary-recipe dispatch', () => {
  const definitionStore = {
    get: () => ({
      contract_id: DOOR_CONTRACT_ID,
      status: 'active',
      door_types: ['webhook'],
      scope: { ingredient_ids: [SEND_SLUG] },
      max_risk_without_approval: 'admin',
      expires_at: null,
    }),
  } as never;

  it('⛔ `recipe` — the ceiling is DROPPED, so the send falls to the LOW ceiling and holds', () => {
    // THE FIX, AT THE SEAM IT LIVES ON. D-209's rule is that an authored ceiling
    // is admissible only where a MACHINE delivers to a DETERMINISTIC path; the
    // recipe runner dispatches arbitrary user content, so it does not qualify.
    const snap = buildWebhookContractSnapshot(
      webhookSource, { definitionStore, now: () => NOW }, 'recipe',
    );
    expect(snap.max_risk_without_approval).toBeUndefined();
    // …and the allowlist is untouched: this narrows APPROVAL, never ACCESS.
    expect(snap.allowed_tools).toContain(SEND_SLUG);
  });

  it('`deterministic_handler` — the carve-out SURVIVES, which is what "keep the rule" means', () => {
    // ⚠ The positive control for the fix. Without it, the assertion above would
    // pass just as well against a builder that had dropped the ceiling for
    // everyone — which is the WIDE option the owner did not choose.
    const snap = buildWebhookContractSnapshot(
      webhookSource, { definitionStore, now: () => NOW }, 'deterministic_handler',
    );
    expect(snap.max_risk_without_approval).toBe('admin');
  });

  it('⚠ a DEAD door drops the ceiling on BOTH paths — the kill-switch is unchanged', () => {
    const dead = { get: () => null } as never;
    for (const path of ['recipe', 'deterministic_handler'] as const) {
      const snap = buildWebhookContractSnapshot(
        webhookSource, { definitionStore: dead, now: () => NOW }, path,
      );
      expect(snap.max_risk_without_approval).toBeUndefined();
      expect(snap.allowed_tools).toHaveLength(0);
    }
  });
});
