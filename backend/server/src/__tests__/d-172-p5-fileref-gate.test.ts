/** D-172 P5 / N.8 — ai-* `llm.data` file_ref read is POLICY-GATED for
 *  `data-file-read` (activation + codex P1 cache-bypass fold).
 *
 *  Security boundary (I-4 / A.8): an `ai-*` call whose `llm.data` is a
 *  `data.file` ref reads the file's content bytes INSIDE the LLM adapter
 *  (`resolveAiFileRef` → the Gateway-gated `fileRead`). That read MUST be
 *  gated for the call's `(channel × actor × contract_id)` scope exactly as a
 *  first-class `data-file-read` ingredient dispatch — otherwise an actor
 *  granted an `ai-*` tool but DENIED `data-file-read` could exfiltrate file
 *  bytes by passing `{ file_ref }` as `llm.data` (or, via the cache, be served
 *  a prior authorized run's file-derived ai result).
 *
 *  This drives the REAL gate end-to-end through `handleExecute` over an
 *  `mcp` / `contracted_user` source. Two layers are exercised:
 *    - the gateway-boundary `evaluateAdmission` probe (the codex P1
 *      cache-bypass fold) — it resolves `llm.data` against the run stores and
 *      runs `admitOne('data-file-read')` BEFORE the executor / L1 cache, so a
 *      deny short-circuits before any byte read OR cached file-derived result;
 *    - the in-adapter `fileRead` (the byte read), proven reached on admit (the
 *      mocked `executeLLM` receives `llm.content_parts`) and NOT reached on
 *      deny (the `dataFileRead` raw-reader spy is never called → no bytes).
 *
 *  `executeLLM` is mocked so the admit path resolves bytes → ContentPart
 *  without a live provider; the file read (`dataFileRead` spy) and the gate
 *  are real. Mirrors `d-172-p2-mail-send-file-read-gate.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  Commit,
  ContractSnapshot,
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
  RecipeError,
} from '@recued/contracts';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';
import type { KernelDispatchers } from '@recued/ingredients';
import type { LLMConfig } from '@recued/llm';

// The LLM substrate is mocked so the admit path runs end-to-end without a
// live provider: `executeLLM` captures the input it is handed (to assert the
// gated file read produced `llm.content_parts`); the file read + the gate are
// REAL. Mirrors `server-executor-pii-policy.test.ts`.
const llmMocks = vi.hoisted(() => ({
  createDefaultRegistry: vi.fn(() => ({ tag: 'adapter-registry' })),
  createQuotaTracker: vi.fn(() => ({ tag: 'quota' })),
  executeLLM: vi.fn(async () => ({ result: 'ok' })),
}));
vi.mock('@recued/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/llm')>();
  return {
    ...actual,
    createDefaultRegistry: llmMocks.createDefaultRegistry,
    createQuotaTracker: llmMocks.createQuotaTracker,
    executeLLM: llmMocks.executeLLM,
  };
});

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const mcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id: 'contract-1',
};

const buildSnapshot = (
  allowed_tools: readonly string[],
  approval_required: readonly string[] = [],
): ContractSnapshot => ({
  contract_id: 'contract-1',
  contract_version: '1',
  allowed_tools,
  approval_required,
  scope_restrictions: [],
  resolved_at: 1_700_000_000_000,
});

// `ai-summarize` — a batch-capable contracted ai function (category 'ai',
// risk 'read'). Its `llm.data` is the field the file_ref overload reads.
// `author` is NON-kernel (`recued-core`) so the dispatch routes by `kind: 'ai'`
// to the LLM adapter — an `author: 'recued'` manifest routes to the kernel
// adapter regardless of kind (`isKernelManifest`).
const aiSummarizeManifest: IngredientManifest = {
  slug: 'ai-summarize',
  name: 'ai-summarize',
  description: 'Test ai-summarize manifest',
  author: 'recued-core',
  kind: 'ai',
  risk_tier: 'read',
  version: 1,
  category: 'ai',
  input: {},
  output: { result: 'summary' },
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

/** `llmData` is the authored `llm.data` value — a literal `{ file_ref }`, a
 *  template ref string (`'{{config.thefile}}'`), or plain text. */
const buildRecipe = (llmData: unknown): RecipeDefinition => ({
  recipe_id: 'd-172-p5-fileref-gate',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'ai-* file_ref gate fixture',
    description: 'Drives an ai-summarize step whose llm.data is a file ref through the gate.',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test', 'd-172', 'ai-fileref'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'sum',
      ingredient: 'ai-summarize',
      input: { 'llm.data': llmData },
    },
  ],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

interface Harness {
  deps: ExecuteHandlerDeps;
  /** Spy: the kernel `data-file-read` raw byte reader. The in-adapter gated
   *  `fileRead` calls it ONLY after admission — so "never called" proves NO
   *  bytes left the warehouse (fail-closed). */
  dataFileReadSpy: ReturnType<typeof vi.fn>;
}

const makeHarness = (
  recipe: RecipeDefinition,
  snapshot: ContractSnapshot,
  opts: { registerFileReadManifest?: boolean } = {},
): Harness => {
  const { registerFileReadManifest = true } = opts;
  const registry = createManifestRegistry('/nonexistent');
  registry.register(aiSummarizeManifest);
  if (registerFileReadManifest) registry.register(dataFileReadManifest);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);

  // The raw byte reader the gated `fileRead` wraps (the same `handleFileRead`
  // the `data-file-read` kernel ingredient dispatches). A spy so we can assert
  // it is NEVER reached when the gate denies (no bytes egress), and IS reached
  // (returning fake image bytes) when the gate admits.
  const dataFileReadSpy = vi.fn(async ({ record_id }: { record_id: string }) => ({
    record_id,
    bytes_b64: 'RklMRUJZVEVT',
    mime_type: 'image/png',
    filename: 'receipt.png',
    size_bytes: 9,
    blob_hash: 'deadbeef',
  }));

  const kernelDispatchers = { dataFileRead: dataFileReadSpy } as unknown as KernelDispatchers;

  const commitStore = createCommitStore(createInMemoryCollection<Commit>());

  const deps: ExecuteHandlerDeps = {
    recipeStore,
    executorConfig: {
      manifests: registry,
      kernelDispatchers,
      // slot_1 present → the LLM adapter is materialised (it runs
      // `resolveAiFileRef` → the gated `fileRead` before the mocked
      // `executeLLM`). The values are inert under the mock.
      llmConfig: { slot_1: { provider: 'openai', model: 'gpt-4.1-mini' } } as unknown as LLMConfig,
    },
    baseVault: {},
    instanceId: 'server-test-fileref-gate',
    commitStore,
  };
  return { deps, dataFileReadSpy };
};

const firstError = (errors: readonly unknown[]): RecipeError => errors[0] as RecipeError;

const FILE_REF = { file_ref: 'file:deadbeefdeadbeefdeadbeefdeadbeef' };

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('D-172 P5 — ai-* file_ref read is policy-gated for data-file-read', () => {
  it('DENY (fail-closed) — refuses an ai-* file_ref read when granted ai-summarize but DENIED data-file-read; NO bytes', async () => {
    const recipe = buildRecipe(FILE_REF);
    const { deps, dataFileReadSpy } = makeHarness(recipe, buildSnapshot(['ai-summarize']));

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['ai-summarize']),
    });

    // Refused at the gateway boundary BEFORE the executor — the per-call probe
    // denied the ai-summarize dispatch because `data-file-read` is not granted.
    expect(result.success).toBe(false);
    const err = firstError(result.errors);
    expect(err.message).toContain('Gateway refused dispatch');
    expect(err.message).toContain('data-file-read');
    expect(err.message).toContain('not in contract.allowed_tools');

    // Fail-closed: NO bytes left the warehouse — the raw file reader was never
    // reached, and the LLM never ran.
    expect(dataFileReadSpy).not.toHaveBeenCalled();
    expect(llmMocks.executeLLM).not.toHaveBeenCalled();
  });

  it('ADMIT (mutation pair) — granting data-file-read flips the outcome: the gated read runs and bytes become a ContentPart', async () => {
    llmMocks.executeLLM.mockClear();
    const recipe = buildRecipe(FILE_REF);
    // The ONLY change vs. the deny test is granting `data-file-read`.
    const { deps, dataFileReadSpy } = makeHarness(recipe, buildSnapshot(['ai-summarize', 'data-file-read']));

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['ai-summarize', 'data-file-read']),
    });

    // No gate deny — the dispatch reached the executor.
    expect(result.errors.some((e) => String((e as RecipeError).message).includes('Gateway refused dispatch'))).toBe(false);
    // The gated read ran (admission passed → bytes fetched THROUGH the gate).
    expect(dataFileReadSpy).toHaveBeenCalledTimes(1);
    expect(dataFileReadSpy).toHaveBeenCalledWith({ record_id: FILE_REF.file_ref });
    // The bytes were rendered into a ContentPart and handed to the model: the
    // mocked executeLLM received `llm.content_parts` (the image) + the textual
    // `llm.data` placeholder.
    expect(llmMocks.executeLLM).toHaveBeenCalledTimes(1);
    const passedInput = (llmMocks.executeLLM.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(passedInput['llm.content_parts']).toEqual([
      { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'RklMRUJZVEVT' } },
    ]);
    expect(passedInput['llm.data']).toBe('[image: receipt.png]');
  });

  it('DENY (dynamic ref) — refuses a `{{config.*}}`-resolved file ref when data-file-read is DENIED; proves the probe resolves before the file-ref test', async () => {
    // The gateway sees RAW input, so a dynamic `llm.data: '{{context.thefile}}'`
    // is a template STRING at the probe. The probe must resolve it against the
    // run stores (the same resolveDeep the adapter uses) to see the file ref —
    // else dynamic refs (the common authoring shape) would slip the cache-bypass
    // gate. Here it resolves to a file record and is denied. (`context.*` is the
    // open runtime namespace — no recipe `variables` declaration needed.)
    const recipe = buildRecipe('{{context.thefile}}');
    const { deps, dataFileReadSpy } = makeHarness(recipe, buildSnapshot(['ai-summarize']));

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['ai-summarize']),
      // a resolved `data.file` record (record_id + storage marker)
      context: { thefile: { record_id: 'file:abc', blob_hash: 'h' } },
    });

    expect(result.success).toBe(false);
    const err = firstError(result.errors);
    expect(err.message).toContain('Gateway refused dispatch');
    expect(err.message).toContain('data-file-read');
    expect(dataFileReadSpy).not.toHaveBeenCalled();
  });

  it('TEXT ai-* is NOT gated — a narrow actor granted only ai-summarize can summarize plain text (no false-deny, no file read)', async () => {
    llmMocks.executeLLM.mockClear();
    // `llm.data` is plain text → not a file ref → the data-file-read probe stays
    // inert → ai-summarize is admitted on its own grant. This pins that the gate
    // never blocks ordinary (text) ai-* for an actor lacking data-file-read.
    const recipe = buildRecipe('just a paragraph of text to summarize');
    const { deps, dataFileReadSpy } = makeHarness(recipe, buildSnapshot(['ai-summarize']));

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['ai-summarize']),
    });

    expect(result.errors.some((e) => String((e as RecipeError).message).includes('Gateway refused dispatch'))).toBe(false);
    expect(llmMocks.executeLLM).toHaveBeenCalledTimes(1);
    expect(dataFileReadSpy).not.toHaveBeenCalled();
  });

  it('FINDING C (fail-closed) — refuses when the data-file-read MANIFEST is absent (registry drift)', async () => {
    // Models packaging / registry drift: `data.file` is readable (the kernel
    // dispatcher is wired off cacheBlobs) but the `data-file-read` manifest is
    // missing → the probe's `admitOne` returns null. The gate MUST fail closed.
    const recipe = buildRecipe(FILE_REF);
    const { deps, dataFileReadSpy } = makeHarness(
      recipe,
      buildSnapshot(['ai-summarize', 'data-file-read']),
      { registerFileReadManifest: false },
    );

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['ai-summarize', 'data-file-read']),
    });

    expect(result.success).toBe(false);
    const err = firstError(result.errors);
    expect(err.message).toContain('Gateway refused dispatch');
    expect(err.message).toContain('manifest absent');
    expect(dataFileReadSpy).not.toHaveBeenCalled();
  });

  it('D-187: a contract cannot approval-gate the secondary read — reads are never-class, so the gated read admits (no leak possible)', async () => {
    // Pre-D-187, `approval_required: ['read']` made the data-file-read probe `ask`, which
    // the gate converted to a terminal deny (to prevent a read-approval riding the ai-*
    // grant). D-187 removes the risk at the SOURCE: a `read` is never-class — the RELAX-
    // only ceiling can never raise it to `ask`, and `approval_required` no longer drives
    // the ceiling. So a contract asking for read-approval is moot; the granted
    // data-file-read ADMITS and the gated read runs. There is no secondary ask to leak.
    // (ACCESS still gates: an actor WITHOUT the data-file-read grant is denied — see the
    // DENY tests above. Reads pass through only once granted, D-177 D7.)
    llmMocks.executeLLM.mockClear();
    const recipe = buildRecipe(FILE_REF);
    const snapshot = buildSnapshot(['ai-summarize', 'data-file-read'], ['read']);
    const { deps, dataFileReadSpy } = makeHarness(recipe, snapshot);

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: snapshot,
    });

    expect(result.errors.some((e) => String((e as RecipeError).message).includes('Gateway refused dispatch'))).toBe(false);
    expect(dataFileReadSpy).toHaveBeenCalledTimes(1);
    expect(llmMocks.executeLLM).toHaveBeenCalledTimes(1);
  });

  // ────────────────────────────────────────────────────────────────
  // codex review-2 — a content_parts ref that RESOLVES to undefined must
  // not skip the gate (the raw-key bypass)
  // ────────────────────────────────────────────────────────────────
  it('REVIEW-2 BYPASS GUARD — a `content_parts` ref resolving to undefined does NOT skip the gate (denied → no bytes)', async () => {
    // The gateway sees RAW input. A caller supplies `llm.content_parts:
    // '{{context.missing}}'` — PRESENT raw, but it resolves to undefined, so
    // the adapter (`resolveAiFileRef`, on the RESOLVED input) WOULD read the
    // file ref and (cache-enabled) the result keys identically to a
    // no-content_parts call. The probe must resolve content_parts too and
    // STILL gate. `context.missing` is intentionally never provided → the pure
    // ref resolves to undefined.
    //
    // The `skip_when: "... is_not_null"` line is the § 8 interplay: a material
    // non-engine context ref derives the recipe TARGETED
    // (`deriveRecipeTargeting`), so a caller-initiated (mcp) dispatch without
    // it would be blocked by `assertRunTargets` BEFORE this probe — see the
    // companion §8-ORDERING test below. An absence-check on the field in any
    // step's `skip_when` (either polarity) is the derivation's author-handled
    // signal and lifts the target — which makes THIS fixture the smarter
    // attacker: the guard-evading shape must still be denied at the probe. At
    // run time the unsupplied ref makes `is_not_null` false, so the step is
    // NOT skipped and the dispatch reaches the gate. (Neither `config.*` shape
    // can express resolved-undefined here: an undeclared ref fails preflight
    // `undeclared_variable_ref`, and a declared optional no-default ValueHint
    // materializes the hint OBJECT into config — non-undefined.)
    const recipe = {
      recipe_id: 'd-172-p5-fileref-gate-cp-bypass',
      version: 1,
      ttl: 60,
      metadata: { name: 'x', description: 'x', author: 'test', supported_platforms: ['test'], tags: ['t'] },
      variables: {},
      prefetch_steps: [],
      steps: [{
        id: 'sum',
        ingredient: 'ai-summarize',
        input: { 'llm.data': FILE_REF, 'llm.content_parts': '{{context.missing}}' },
        skip_when: '{{context.missing}} is_not_null',
      }],
      output: { sidebar: [] },
    } as unknown as RecipeDefinition;
    const { deps, dataFileReadSpy } = makeHarness(recipe, buildSnapshot(['ai-summarize']));

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['ai-summarize']),
    });

    expect(result.success).toBe(false);
    const err = firstError(result.errors);
    expect(err.message).toContain('Gateway refused dispatch');
    expect(err.message).toContain('data-file-read');
    expect(dataFileReadSpy).not.toHaveBeenCalled();
  });

  it('§8-ORDERING — the original review-2 CONTEXT-ref shape is blocked by the targeting guard BEFORE the probe (fail-closed, no bytes)', async () => {
    llmMocks.executeLLM.mockClear();
    // The original codex review-2 attack fixture: `llm.content_parts:
    // '{{context.missing}}'` with the context never supplied. A material
    // non-engine context ref derives the recipe TARGETED (§ 8), and `mcp` is a
    // caller-initiated trigger_source, so `assertRunTargets` throws
    // `recipe_target_required` before binding / gating / the executor. This pin
    // is the defense-in-depth ordering: if a future derivation change exempts
    // ai-* auxiliary fields (or `context.*` refs generally) from targeting,
    // this test fails — re-evaluate the probe pin above, which would then be
    // the ONLY guard for this shape on caller channels too.
    const recipe = {
      recipe_id: 'd-172-p5-fileref-gate-cp-ctx-targeted',
      version: 1,
      ttl: 60,
      metadata: { name: 'x', description: 'x', author: 'test', supported_platforms: ['test'], tags: ['t'] },
      variables: {},
      prefetch_steps: [],
      steps: [{
        id: 'sum',
        ingredient: 'ai-summarize',
        input: { 'llm.data': FILE_REF, 'llm.content_parts': '{{context.missing}}' },
      }],
      output: { sidebar: [] },
    } as unknown as RecipeDefinition;
    const { deps, dataFileReadSpy } = makeHarness(recipe, buildSnapshot(['ai-summarize']));

    let thrown: (Error & { code?: string; details?: unknown }) | undefined;
    try {
      await handleExecute(deps, {
        recipe_id: recipe.recipe_id,
        trigger_source: 'mcp',
        execution_source: mcpSource,
        contract_snapshot: buildSnapshot(['ai-summarize']),
      });
    } catch (e) {
      thrown = e as Error & { code?: string; details?: unknown };
    }
    expect(thrown).toBeDefined();
    expect(thrown!.code).toBe('recipe_target_required');
    expect(thrown!.details).toEqual({ missing: [{ kind: 'context', key: 'missing' }] });
    expect(thrown!.message).toContain('context.missing');

    // Fail-closed at the earlier boundary: no bytes, no model call.
    expect(dataFileReadSpy).not.toHaveBeenCalled();
    expect(llmMocks.executeLLM).not.toHaveBeenCalled();
  });

  it('NESTED-PATH caller shape — a guard-SATISFIED dispatch whose content_parts nested path resolves undefined is still denied at the probe', async () => {
    llmMocks.executeLLM.mockClear();
    // Codex review Q3 fold — the third shape: the targeting guard assesses
    // context ROOTS (`deriveRecipeTargeting` collects `context.parts`), so a
    // caller who supplies `parts` satisfies § 8 — but the authored ref walks a
    // NESTED path (`{{context.parts.inline}}`) that resolves undefined on the
    // supplied object. No skip_when carve-out involved: this pins that a
    // CALLER channel reaches the probe's resolved-undefined branch through a
    // guard-satisfied dispatch, so the probe pin does not depend on machine
    // (guard-exempt) dispatches alone.
    const recipe = {
      recipe_id: 'd-172-p5-fileref-gate-cp-nested',
      version: 1,
      ttl: 60,
      metadata: { name: 'x', description: 'x', author: 'test', supported_platforms: ['test'], tags: ['t'] },
      variables: {},
      prefetch_steps: [],
      steps: [{
        id: 'sum',
        ingredient: 'ai-summarize',
        input: { 'llm.data': FILE_REF, 'llm.content_parts': '{{context.parts.inline}}' },
      }],
      output: { sidebar: [] },
    } as unknown as RecipeDefinition;
    const { deps, dataFileReadSpy } = makeHarness(recipe, buildSnapshot(['ai-summarize']));

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['ai-summarize']),
      // Root supplied (satisfies § 8) — but carries no `inline` key, so the
      // nested ref resolves undefined at the probe.
      context: { parts: { source: 'caller' } },
    });

    expect(result.success).toBe(false);
    const err = firstError(result.errors);
    expect(err.message).toContain('Gateway refused dispatch');
    expect(err.message).toContain('data-file-read');
    expect(dataFileReadSpy).not.toHaveBeenCalled();
    expect(llmMocks.executeLLM).not.toHaveBeenCalled();
  });

  it('content_parts GENUINELY supplied — the gate is correctly skipped (the adapter uses the parts, never reads the file)', async () => {
    llmMocks.executeLLM.mockClear();
    // A literal, present `llm.content_parts` → `resolveAiFileRef` returns the
    // input unchanged (no file read). The probe correctly skips (resolved cp
    // present), so a narrow actor (only ai-summarize) is admitted — no file
    // content is read, so no `data-file-read` grant is needed.
    const recipe = {
      recipe_id: 'd-172-p5-fileref-gate-cp-present',
      version: 1,
      ttl: 60,
      metadata: { name: 'x', description: 'x', author: 'test', supported_platforms: ['test'], tags: ['t'] },
      variables: {},
      prefetch_steps: [],
      steps: [{
        id: 'sum',
        ingredient: 'ai-summarize',
        input: { 'llm.data': FILE_REF, 'llm.content_parts': [{ type: 'text', text: 'pre-supplied' }] },
      }],
      output: { sidebar: [] },
    } as unknown as RecipeDefinition;
    const { deps, dataFileReadSpy } = makeHarness(recipe, buildSnapshot(['ai-summarize']));

    const result = await handleExecute(deps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'mcp',
      execution_source: mcpSource,
      contract_snapshot: buildSnapshot(['ai-summarize']),
    });

    expect(result.errors.some((e) => String((e as RecipeError).message).includes('Gateway refused dispatch'))).toBe(false);
    expect(dataFileReadSpy).not.toHaveBeenCalled(); // adapter used content_parts, no file read
    expect(llmMocks.executeLLM).toHaveBeenCalledTimes(1);
  });
});
