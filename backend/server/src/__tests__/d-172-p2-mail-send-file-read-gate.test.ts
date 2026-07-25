/** D-172 P2 (review F2) — mail-send attachment reads are POLICY-GATED.
 *
 *  Security boundary: a `mail-send` carrying `attachments` reads `data.file`
 *  content bytes out of the warehouse INSIDE `MailCollection.send` (via
 *  `handleFileRead`). That inner read MUST be gated for the call's
 *  `(channel × actor × contract_id)` scope exactly as a first-class
 *  `data-file-read` ingredient dispatch would be (D-172 I-4 / A.8) — otherwise
 *  an actor granted `mail-send` but DENIED `data-file-read` could exfiltrate
 *  arbitrary file bytes by attaching them.
 *
 *  The gate is composed at the Gateway dispatch boundary: the per-call
 *  admission probe (`evaluateAdmission`, built in `handleExecute`) evaluates
 *  `data-file-read` alongside the `mail-send` slug whenever attachments are
 *  present, and a `data-file-read` DENY short-circuits the dispatch with
 *  `PreflightDeniedError` (surfaced as `RECIPE_POLICY_DENIED`) BEFORE the inner
 *  `mail-send` dispatch ever runs — so `provider.send` is never reached.
 *
 *  This drives the REAL `evaluateAdmission` closure end-to-end through
 *  `handleExecute` over an `mcp` / `contracted_user` source whose
 *  `ContractSnapshot.allowed_tools` grants `mail-send` but NOT `data-file-read`
 *  (the exact threat scenario). Mirrors the file-read-handler Gateway-boundary
 *  test (`collections/file/__tests__/file-read-handler.test.ts`).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type Commit,
  type ContractSnapshot,
  type ExecutionSource,
  type IngredientManifest,
  type RecipeDefinition,
  type RecipeError,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createCommitStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';

import {
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import type { KernelDispatchers } from '@recued/ingredients';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

/** An MCP / contracted-user source — the realistic threat surface for F2
 *  (an agent driving recipes under a contract). Outbound sends are NOT
 *  escalated to `ask` for `contracted_user` (they are gated by the
 *  contract's `allowed_tools`), so the run isn't paused for approval — it
 *  is admitted/denied purely by the per-tool allowlist. */
const mcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id: 'contract-1',
};

/** Grants the given `allowed_tools`. `scope_restrictions` is EMPTY, which
 *  admits every scope path (`evaluateScopeAdmissibility` short-circuits to
 *  admit with no restrictions) — so the scope fence never masks the per-tool
 *  allowlist decision. The ONLY differentiator between the refuse / allow
 *  cases is whether `data-file-read` is in `allowed_tools`, isolating the F2
 *  tool-grant gate. */
const buildSnapshot = (
  allowed_tools: readonly string[],
  // Finding B — defaults EMPTY (admits every scope, isolating the per-tool
  // allowlist). A non-empty list activates the scope fence
  // (`evaluateScopeAdmissibility`) over the derived dispatch scope —
  // `data.file` for the F2 `data-file-read` probe.
  scope_restrictions: readonly string[] = [],
  // 3rd-pass resume-path finding — risk-tiers that require approval. With
  // `['read']`, the `data-file-read` probe (risk_tier `read`) returns `ask`;
  // the gate must convert that to a terminal deny (not leak a pausable
  // mail-send ask).
  approval_required: readonly string[] = [],
): ContractSnapshot => ({
  contract_id: 'contract-1',
  contract_version: '1',
  allowed_tools,
  approval_required,
  scope_restrictions,
  resolved_at: 1_700_000_000_000,
});

const mailSendManifest: IngredientManifest = {
  slug: 'mail-send',
  name: 'mail-send',
  description: 'Test mail-send manifest',
  author: 'recued',
  kind: 'storage',
  risk_tier: 'write',
  version: 1,
  category: 'action',
  input: {},
  output: { message_id: 'message_id' },
} as unknown as IngredientManifest;

const dataFileReadManifest: IngredientManifest = {
  slug: 'data-file-read',
  name: 'data-file-read',
  description: 'Test data-file-read manifest',
  author: 'recued',
  kind: 'storage',
  risk_tier: 'read',
  version: 1,
  category: 'data',
  input: { record_id: null },
  output: { bytes_b64: 'bytes_b64' },
} as unknown as IngredientManifest;

const buildMailSendRecipe = (
  // Finding A — `attachments` mirrors EXACTLY what the kernel `mail-send`
  // case accepts via `coerceStringArray`: a SINGLE STRING or a `string[]`
  // (or absent). The string form is the F2 finding-A bypass vector.
  attachments: string[] | string | undefined,
): RecipeDefinition => ({
  recipe_id: 'd-172-p2-mail-send-gate',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'mail-send attachment gate fixture',
    description: 'Drives a mail-send step carrying attachments through the gate.',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test', 'd-172', 'mail-send'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'send',
      ingredient: 'mail-send',
      input: {
        sender_mail_instance: 'work',
        to: ['bob@example.com'],
        subject: 'hi',
        body: 'hello',
        ...(attachments !== undefined ? { attachments } : {}),
      },
    },
  ],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

interface Harness {
  deps: ExecuteHandlerDeps;
  /** Spy: the kernel `mail-send` dispatcher. Asserts the inner send NEVER
   *  ran when `data-file-read` is denied (proves the gate short-circuits
   *  before `provider.send`). */
  mailSendSpy: ReturnType<typeof vi.fn>;
}

const makeHarness = (
  recipe: RecipeDefinition,
  snapshot: ContractSnapshot,
  // Finding C — when false, the `data-file-read` MANIFEST is NOT registered
  // (modeling a packaging / registry drift where the file collection +
  // fileReadDeps register off `cacheBlobs` independent of manifest loading).
  // The F2 probe's `admitOne('data-file-read')` then returns `null` and the
  // gate MUST fail closed.
  registerFileReadManifest = true,
): Harness => {
  const registry = createManifestRegistry('/nonexistent');
  registry.register(mailSendManifest);
  if (registerFileReadManifest) registry.register(dataFileReadManifest);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);

  // The inner mail-send dispatcher — a spy that records every call. If the
  // F2 gate fires, this is NEVER reached (the deny short-circuits in the
  // Gateway, ahead of the inner dispatch). Returns a minimal SentMessage.
  const mailSendSpy = vi.fn(async () => ({
    source_id: 'srcid',
    message_id: '<msgid@example.com>',
    sent_at: 1_700_000_000_000,
    _id: null,
    _collection: 'data.mail' as const,
  }));

  const kernelDispatchers = {
    mailSend: mailSendSpy,
  } as unknown as KernelDispatchers;

  const commitStore = createCommitStore(createInMemoryCollection<Commit>());

  const deps: ExecuteHandlerDeps = {
    recipeStore,
    executorConfig: { manifests: registry, kernelDispatchers },
    baseVault: {},
    instanceId: 'server-test-f2',
    commitStore,
    // D-187 slice 4 — an mcp (contracted) `mail-send` is a WRITE, which surfaces under
    // the contracted LOW ceiling → the run HOLDS for approval. A checkpointStore lets
    // that hold land cleanly (awaiting_approval) instead of CHECKPOINT_STORE_UNAVAILABLE.
    // (The data-file-read DENY tests short-circuit before the hold, so it is inert there.)
    checkpointStore: { write: vi.fn(async () => undefined) } as unknown as ExecuteHandlerDeps['checkpointStore'],
    // D-195 (2d1e292ad) — a preflight hold ALSO requires an audit log: the
    // approval anchor (idempotency + targeting) lands in the awaiting audit
    // row, so a checkpoint alone is now refused with CHECKPOINT_WRITE_FAILED
    // and the run never reaches `awaiting_approval`. Wiring it restores the
    // hold these tests assert; it does not relax the gate — the DENY tests
    // short-circuit before the hold and stay green either way.
    auditLog: createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    ),
  };
  return { deps, mailSendSpy };
};

const errorsContainCode = (errors: readonly unknown[], code: string): boolean =>
  errors.some(
    (e) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code,
  );

const firstError = (errors: readonly unknown[]): RecipeError =>
  errors[0] as RecipeError;

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('D-172 P2 (F2) — mail-send attachment read is policy-gated for data-file-read', () => {
  it('refuses the send when the scope is granted mail-send but DENIED data-file-read', async () => {
    const recipe = buildMailSendRecipe(['file:deadbeefdeadbeefdeadbeefdeadbeef']);
    const { deps, mailSendSpy } = makeHarness(
      recipe,
      // mail-send GRANTED, data-file-read ABSENT.
      buildSnapshot(['mail-send']),
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['mail-send']),
    });

    // The send is REFUSED at the Gateway: the per-call admission probe denied
    // the mail-send dispatch because `data-file-read` is not in the contract's
    // `allowed_tools`. (The engine surfaces a per-call gateway deny as a step
    // error — code `NETWORK_ERROR` per the engine's generic ingredient-error
    // mapping — but the deny MESSAGE unambiguously names the F2 cause: the
    // `data-file-read` tool not being granted. The `PreflightDeniedError` the
    // gateway raised carries `code: 'RECIPE_POLICY_DENIED'`; the engine's
    // step-error wrapper is what re-codes it.)
    expect(result.success).toBe(false);
    const err = firstError(result.errors);
    expect(err.message).toContain('Gateway refused dispatch');
    expect(err.message).toContain('data-file-read');
    expect(err.message).toContain('not in contract.allowed_tools');

    // Fail-closed: the inner mail-send dispatch NEVER ran → provider.send
    // (downstream of mailSend) was never reached, so no file bytes egress.
    expect(mailSendSpy).not.toHaveBeenCalled();
  });

  it('D-187: the mail-send WRITE surfaces (holds) when BOTH granted — the data-file-read read admits, the egress holds for approval', async () => {
    // D-187 slice 4 — granting data-file-read lets the secondary read ADMIT (never-class),
    // but on an mcp (contracted) source the `mail-send` WRITE surfaces under the LOW
    // ceiling → the run HOLDS for approval (clean awaiting_approval, no errors). So the
    // egress is gated at the SEND (write approval), never silently dispatched — and there
    // is NO data-file-read policy deny (the secondary admitted).
    const recipe = buildMailSendRecipe(['file:deadbeefdeadbeefdeadbeefdeadbeef']);
    const { deps, mailSendSpy } = makeHarness(
      recipe,
      buildSnapshot(['mail-send', 'data-file-read']),
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['mail-send', 'data-file-read']),
    });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    expect(mailSendSpy).not.toHaveBeenCalled();
  });

  it('does NOT add the data-file-read gate to a mail-send WITHOUT attachments (but the write still surfaces)', async () => {
    // A plain text send carries no attachments → the F2 secondary data-file-read gate is
    // inert (no RECIPE_POLICY_DENIED). D-187 slice 4 — the `mail-send` WRITE itself still
    // surfaces under the contracted (mcp) LOW ceiling, so the run HOLDS for approval
    // rather than dispatching: granting only mail-send is sufficient for ACCESS, but the
    // send is gated at approval regardless of attachments.
    const recipe = buildMailSendRecipe(undefined);
    const { deps, mailSendSpy } = makeHarness(recipe, buildSnapshot(['mail-send']));

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['mail-send']),
    });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    expect(mailSendSpy).not.toHaveBeenCalled();
  });

  it('MUTATION GUARD — granting data-file-read flips the refusal to a clean hold (deny attributable to the access gate)', async () => {
    // Pins the security property: the refusal in the first test is caused specifically by
    // the missing `data-file-read` grant. Granting it is the ONLY change here, and it
    // FLIPS the outcome — from a `data-file-read` access DENY (gateway-refused) to a clean
    // HOLD (the secondary read admits; the mail-send WRITE surfaces under the contracted
    // LOW ceiling, no policy deny). So the refusal is attributable to the access gate, not
    // an unrelated denial. (Under D-187 the granted send no longer DISPATCHES — the write
    // surfaces for approval — but it is no longer REFUSED on the data-file-read axis.)
    const recipe = buildMailSendRecipe(['file:deadbeefdeadbeefdeadbeefdeadbeef']);
    const { deps, mailSendSpy } = makeHarness(
      recipe,
      buildSnapshot(['mail-send', 'data-file-read']),
    );
    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['mail-send', 'data-file-read']),
    });
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    expect(mailSendSpy).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────
  // Review F2 finding A — a SINGLE STRING attachment must not bypass the gate
  // ────────────────────────────────────────────────────────────────
  it('FINDING A — refuses a STRING attachment when data-file-read is DENIED', async () => {
    // The kernel `mail-send` case coerces `attachments` via `coerceStringArray`,
    // which accepts a single string (`attachments: 'file:abc'` → `['file:abc']`)
    // and forwards it to `MailCollection.send` → `handleFileRead`. The gate MUST
    // treat a non-empty string as attachment-bearing, exactly as the kernel does —
    // otherwise a string attachment reads file bytes ungated.
    const recipe = buildMailSendRecipe('file:deadbeefdeadbeefdeadbeefdeadbeef');
    const { deps, mailSendSpy } = makeHarness(
      recipe,
      buildSnapshot(['mail-send']), // data-file-read ABSENT.
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['mail-send']),
    });

    expect(result.success).toBe(false);
    const err = firstError(result.errors);
    expect(err.message).toContain('Gateway refused dispatch');
    expect(err.message).toContain('data-file-read');
    expect(err.message).toContain('not in contract.allowed_tools');
    // Fail-closed: the inner mail-send dispatch NEVER ran.
    expect(mailSendSpy).not.toHaveBeenCalled();
  });

  it('FINDING A — a STRING attachment with data-file-read granted holds (no data-file-read deny; the write surfaces)', async () => {
    // The ONLY change vs. the STRING-attachment refusal above is granting `data-file-read`;
    // it flips the outcome from a data-file-read access DENY to a clean HOLD — so the
    // refusal there was attributable to the F2 gate firing on the STRING attachment. Under
    // D-187 the granted send HOLDS (the mail-send write surfaces under the contracted LOW
    // ceiling), it does not silently dispatch.
    const recipe = buildMailSendRecipe('file:deadbeefdeadbeefdeadbeefdeadbeef');
    const { deps, mailSendSpy } = makeHarness(
      recipe,
      buildSnapshot(['mail-send', 'data-file-read']),
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['mail-send', 'data-file-read']),
    });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    expect(mailSendSpy).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────
  // Review F2 finding B — scope_restrictions are evaluated against data.file
  // ────────────────────────────────────────────────────────────────
  it('FINDING B — admits attachments when scope_restrictions ALLOW data.file', async () => {
    // `deriveDispatchScope('data-file-read')` must yield `data.file` so a
    // scope fence covering `data.file.*` admits the F2 secondary read. (Before
    // the fix it derived `data.data`, which this restriction would NOT match —
    // the send would be refused even though the policy intends to allow it.)
    // `data.mail.*` is ALSO listed because the scope fence applies per-slug —
    // the `mail-send` dispatch's own `data.mail` path must clear it too — so the
    // ONLY axis under test here is whether `data.file` (the file-read probe) is
    // admitted.
    const recipe = buildMailSendRecipe(['file:deadbeefdeadbeefdeadbeefdeadbeef']);
    const allowBoth = ['data.mail.*', 'data.file.*'];
    const { deps, mailSendSpy } = makeHarness(
      recipe,
      buildSnapshot(['mail-send', 'data-file-read'], allowBoth),
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(
        ['mail-send', 'data-file-read'],
        allowBoth,
      ),
    });

    // Scope ALLOWS `data.file` → the secondary data-file-read clears the scope fence (no
    // `scope_not_in_restrictions`). D-187 — the read then admits (never-class) and the
    // mail-send WRITE surfaces under the contracted LOW ceiling → clean HOLD, not a
    // silent dispatch; no policy deny.
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    expect(mailSendSpy).not.toHaveBeenCalled();
  });

  it('FINDING B — refuses attachments when scope_restrictions DENY data.file', async () => {
    // A scope fence that allows a DIFFERENT scope (here `data.mail.*`, so
    // `mail-send`'s own `data.mail` dispatch still passes) but NOT `data.file`
    // must refuse the F2 secondary `data-file-read` probe — proving the derived
    // scope is `data.file` and is being evaluated. (With the pre-fix `data.data`
    // derivation, this `data.mail.*`-only fence would ALSO refuse, so the test
    // discriminates via the deny CAUSE: `scope_not_in_restrictions` on
    // `data.file`.)
    const recipe = buildMailSendRecipe(['file:deadbeefdeadbeefdeadbeefdeadbeef']);
    const { deps, mailSendSpy } = makeHarness(
      recipe,
      buildSnapshot(['mail-send', 'data-file-read'], ['data.mail.*']),
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(
        ['mail-send', 'data-file-read'],
        ['data.mail.*'],
      ),
    });

    expect(result.success).toBe(false);
    const err = firstError(result.errors);
    expect(err.message).toContain('Gateway refused dispatch');
    // The deny is the scope fence over the derived `data.file` path — NOT the
    // allowlist (data-file-read IS granted here).
    expect(err.message).toContain('scope_not_in_restrictions');
    expect(err.message).toContain('data.file');
    expect(mailSendSpy).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────
  // Review F2 finding C — a null data-file-read decision must FAIL CLOSED
  // ────────────────────────────────────────────────────────────────
  it('FINDING C — refuses attachments when the data-file-read MANIFEST is absent (fail-closed)', async () => {
    // Models packaging / registry drift: the file collection + fileReadDeps
    // register off `cacheBlobs` (so `data.file` is READABLE), but the
    // `data-file-read` manifest is missing → the F2 probe returns `null`. The
    // gate MUST refuse (fail-closed) rather than fall through to the mail-send
    // admission — otherwise file bytes egress ungated.
    const recipe = buildMailSendRecipe(['file:deadbeefdeadbeefdeadbeefdeadbeef']);
    const { deps, mailSendSpy } = makeHarness(
      recipe,
      // mail-send IS granted; data-file-read manifest simply not registered.
      buildSnapshot(['mail-send', 'data-file-read']),
      /* registerFileReadManifest */ false,
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['mail-send', 'data-file-read']),
    });

    expect(result.success).toBe(false);
    const err = firstError(result.errors);
    expect(err.message).toContain('Gateway refused dispatch');
    expect(err.message).toContain('manifest absent');
    // Fail-closed: the inner mail-send dispatch NEVER ran.
    expect(mailSendSpy).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────
  // Review F2 (3rd pass) — a secondary data-file-read `ask` must NOT leak to
  // the outer mail-send grant (the approval-resume bypass)
  // ────────────────────────────────────────────────────────────────
  it('FINDING (resume-path) — D-187: the secondary read can NEVER produce a pausable ask (never-class), so no leak is possible', async () => {
    // The pre-D-187 risk: a secondary `data-file-read` `ask` (from a contract that put
    // `read` in `approval_required`) leaking as a `mail-send` approval on resume. D-187
    // makes that structurally impossible at the SOURCE: a `read` is never-class — the
    // RELAX-only trust ceiling can never raise it to `ask`, and `approval_required` no
    // longer drives the ceiling (it's the LOW constant). So the secondary read ADMITS,
    // and the run HOLDS only on the `mail-send` WRITE's own approval (write > the
    // contracted LOW ceiling) — its own ask, never a proxied data-file-read one. The
    // egress still never silently dispatches.
    const recipe = buildMailSendRecipe(['file:deadbeefdeadbeefdeadbeefdeadbeef']);
    const snapshot = buildSnapshot(
      ['mail-send', 'data-file-read'], // both granted…
      [], // …no scope fence…
      ['read'], // …a contract asking for read-approval no longer escalates (never-class).
    );
    const { deps, mailSendSpy } = makeHarness(recipe, snapshot);

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: snapshot,
    });

    // The run HOLDS on the mail-send write's own approval (clean awaiting_approval, no
    // errors) — NOT a data-file-read deny, and NOT a silent send. There is no secondary
    // read ask to leak.
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
    expect(mailSendSpy).not.toHaveBeenCalled();
  });
});
