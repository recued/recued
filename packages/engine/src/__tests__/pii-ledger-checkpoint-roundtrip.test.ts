import { beforeEach, describe, expect, it } from 'vitest';
import {
  executeRecipe,
  type ExecutionContext,
  type ExecutionResult,
  type IngredientExecutor,
} from '@recued/engine';
import {
  PreflightRequiredSignal,
  type NamespaceStores,
  type PiiLedgerStoreSnapshot,
  type RecipeDefinition,
  type RecipeStep,
} from '@recued/contracts';
import { _resetPiiLedgerState } from '@recued/transforms';

const RAW = {
  email: 'alice@example.test',
  name: 'Alice Smith',
};

const EMAIL_ALIAS = 'm1@d1.invalid';
const NAME_ALIAS = 'pii.Person1';

const METADATA = {
  name: 'PII ledger checkpoint round-trip',
  description: 'Preflight pause/resume fixture for pii ledger snapshots',
  author: 'test',
  supported_platforms: ['test'],
};

type AiInput = { email: string; name: string };
type PausedApproval = NonNullable<ExecutionResult['awaiting_approval']>;

const baseStores = (): NamespaceStores => ({
  vault: {},
  config: {},
  context: {},
  meta: {},
  step: {},
});

const asSteps = (steps: Array<Record<string, unknown>>): RecipeStep[] =>
  steps as unknown as RecipeStep[];

const recipeWithRestore = (): RecipeDefinition => ({
  recipe_id: 'pii-ledger-checkpoint-roundtrip',
  version: 1,
  ttl: 300,
  metadata: METADATA,
  variables: {},
  prefetch_steps: [],
  steps: asSteps([
    { id: 'reader', ingredient: 'profile-reader' },
    {
      id: 'protect',
      transform: 'pii-protect',
      data: '{{step.reader}}',
      fields: [
        { path: 'email', kind: 'email' },
        { path: 'name', kind: 'name' },
      ],
    },
    { id: 'ai', ingredient: 'ai-prompt', input: '{{step.protect.aliased}}' },
    {
      id: 'restore',
      transform: 'pii-restore',
      data: '{{step.ai}}',
      ledger_handle: '{{step.protect.ledger_handle}}',
    },
    { id: 'downstream', transform: 'template', template: '{{step.restore.restored.answer}}' },
  ]),
  output: { sidebar: [{ type: 'summary', source: 'step.downstream' }] },
});

const recipeWithoutRestore = (): RecipeDefinition => ({
  ...recipeWithRestore(),
  recipe_id: 'pii-ledger-checkpoint-safety-net',
  steps: asSteps([
    { id: 'reader', ingredient: 'profile-reader' },
    {
      id: 'protect',
      transform: 'pii-protect',
      data: '{{step.reader}}',
      fields: [
        { path: 'email', kind: 'email' },
        { path: 'name', kind: 'name' },
      ],
    },
    { id: 'ai', ingredient: 'ai-prompt', input: '{{step.protect.aliased}}' },
  ]),
  output: { sidebar: [{ type: 'summary', source: 'step.ai' }] },
});

const noPiiRecipe = (): RecipeDefinition => ({
  recipe_id: 'pii-ledger-checkpoint-no-pii',
  version: 1,
  ttl: 300,
  metadata: METADATA,
  variables: {},
  prefetch_steps: [],
  steps: asSteps([
    { id: 'ai', ingredient: 'ai-prompt', input: { prompt: 'hello' } },
  ]),
  output: { sidebar: [] },
});

const makeCtx = (
  recipe: RecipeDefinition,
  ingredientExecutor: IngredientExecutor,
  stores: NamespaceStores = baseStores(),
): ExecutionContext => ({ recipe, stores, ingredientExecutor });

const pausePiiRun = async (
  recipe: RecipeDefinition = recipeWithRestore(),
): Promise<{ result: ExecutionResult; approval: PausedApproval }> => {
  const result = await executeRecipe(makeCtx(recipe, async (slug) => {
    if (slug === 'profile-reader') return structuredClone(RAW);
    if (slug === 'ai-prompt') throw new PreflightRequiredSignal('approval required');
    throw new Error(`unexpected ingredient: ${slug}`);
  }));

  expect(result.awaiting_approval).toBeDefined();
  return { result, approval: result.awaiting_approval! };
};

const resumePiiRun = async (
  recipe: RecipeDefinition,
  approval: PausedApproval,
  piiLedgers?: PiiLedgerStoreSnapshot,
): Promise<{ result: ExecutionResult; ctx: ExecutionContext; aiInputs: AiInput[] }> => {
  const stores = baseStores();
  (stores.step as Record<string, unknown>) = structuredClone(approval.step_state);
  const aiInputs: AiInput[] = [];
  const ingredientExecutor: IngredientExecutor = async (slug, input) => {
    if (slug === 'profile-reader') {
      throw new Error('reader must not rerun during resume');
    }
    if (slug !== 'ai-prompt') {
      throw new Error(`unexpected ingredient: ${slug}`);
    }

    const aiInput = input as AiInput;
    aiInputs.push(structuredClone(aiInput));
    return { answer: `AI saw ${aiInput.name} at ${aiInput.email}` };
  };
  const ctx: ExecutionContext = {
    recipe,
    stores,
    ingredientExecutor,
    resumeFrom: {
      gated_step_id: approval.gated_step_id,
      ...(piiLedgers !== undefined ? { pii_ledgers: piiLedgers } : {}),
    },
  };

  const result = await executeRecipe(ctx);
  return { result, ctx, aiInputs };
};

const json = (value: unknown): string => JSON.stringify(value);

beforeEach(() => {
  _resetPiiLedgerState();
});

describe('PII ledger checkpoint round-trip', () => {
  it('pauses with pii_ledgers and step_state for the preflight-gated AI step', async () => {
    const { result, approval } = await pausePiiRun();

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(approval.gated_step_id).toBe('ai');

    const stepState = approval.step_state as Record<string, unknown>;
    expect(stepState.reader).toEqual(RAW);
    const protect = stepState.protect as {
      aliased: AiInput;
      ledger_handle: string;
    };
    expect(protect.aliased).toEqual({ email: EMAIL_ALIAS, name: NAME_ALIAS });
    expect(protect.ledger_handle).toBe('pii-ledger:1.1');

    expect(approval.pii_ledgers).toBeDefined();
    expect(approval.pii_ledgers!.handles).toEqual([protect.ledger_handle]);
    expect(approval.pii_ledgers!.by_kind_real_value.map(([key]) => key)).toEqual([
      'domain::example.test',
      'email_local::alice@example.test',
      'name::Alice Smith',
    ]);
    expect(approval.pii_ledgers!.by_kind_base_alias.map(([key]) => key)).toEqual([
      'domain::d1.invalid',
      'email_local::m1',
      'name::pii.Person1',
    ]);
    expect(result.steps.map((step) => step.id)).toEqual(['reader', 'protect']);
  });

  it('omits pii_ledgers when a no-PII recipe pauses', async () => {
    const result = await executeRecipe(makeCtx(noPiiRecipe(), async () => {
      throw new PreflightRequiredSignal('approval required');
    }));

    expect(result.awaiting_approval).toBeDefined();
    expect(result.awaiting_approval!.gated_step_id).toBe('ai');
    expect(result.awaiting_approval!).not.toHaveProperty('pii_ledgers');
  });

  it('hydrates pii_ledgers on resume so explicit pii-restore returns real values', async () => {
    const recipe = recipeWithRestore();
    const { approval } = await pausePiiRun(recipe);
    const resumed = await resumePiiRun(recipe, approval, approval.pii_ledgers);

    expect(resumed.result.success).toBe(true);
    expect(resumed.result.errors).toEqual([]);
    expect(resumed.result.awaiting_approval).toBeUndefined();
    expect(resumed.aiInputs).toEqual([{ email: EMAIL_ALIAS, name: NAME_ALIAS }]);

    const downstream = (resumed.ctx.stores.step as Record<string, unknown>).downstream;
    expect(downstream).toBe(`AI saw ${RAW.name} at ${RAW.email}`);
    expect(resumed.result.output.sidebar[0].data).toBe(`AI saw ${RAW.name} at ${RAW.email}`);
    expect(json(resumed.result.output.sidebar)).not.toContain(NAME_ALIAS);
    expect(json(resumed.result.output.sidebar)).not.toContain(EMAIL_ALIAS);
  });

  it('without pii_ledgers, resume completes but explicit restore passes aliases through', async () => {
    const recipe = recipeWithRestore();
    const { approval } = await pausePiiRun(recipe);
    const resumed = await resumePiiRun(recipe, approval);

    expect(resumed.result.success).toBe(true);
    expect(resumed.result.errors).toEqual([]);
    expect(resumed.aiInputs).toEqual([{ email: EMAIL_ALIAS, name: NAME_ALIAS }]);

    const rendered = json(resumed.result.output.sidebar);
    expect(rendered).toContain(NAME_ALIAS);
    expect(rendered).toContain(EMAIL_ALIAS);
    expect(rendered).not.toContain(RAW.name);
    expect(rendered).not.toContain(RAW.email);
  });

  it('uses hydrated restoreAll for sidebar output when the recipe omits pii-restore', async () => {
    const recipe = recipeWithoutRestore();
    const { approval } = await pausePiiRun(recipe);
    const resumed = await resumePiiRun(recipe, approval, approval.pii_ledgers);

    expect(resumed.result.success).toBe(true);
    expect(resumed.aiInputs).toEqual([{ email: EMAIL_ALIAS, name: NAME_ALIAS }]);

    const rawStepAi = (resumed.ctx.stores.step as Record<string, unknown>).ai;
    expect(json(rawStepAi)).toContain(NAME_ALIAS);
    expect(json(rawStepAi)).toContain(EMAIL_ALIAS);

    const sidebarData = resumed.result.output.sidebar[0].data;
    expect(sidebarData).toEqual({ answer: `AI saw ${RAW.name} at ${RAW.email}` });
    expect(json(sidebarData)).not.toContain(NAME_ALIAS);
    expect(json(sidebarData)).not.toContain(EMAIL_ALIAS);
  });
});
