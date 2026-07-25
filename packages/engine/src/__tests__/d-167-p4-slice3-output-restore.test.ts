/**
 * D-167 P4 Slice 3 — engine output guarantee for recipe-mode PII aliases.
 *
 * These tests use a tiny synthetic recipe so the output source is fully
 * controlled and no explicit `pii-restore` step exists. The engine must still
 * restore user-facing render data from the run-local ledger.
 */
import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';

import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor, ProgressEvent } from '../types.js';

const REAL_EMAIL = 'alice@acme.com';
const REAL_NAME = 'Alice Smith';
const EMAIL_ALIAS = 'm1@d1.invalid';
const NAME_ALIAS = 'pii.Person1';

const RAW_PII = {
  from: REAL_EMAIL,
  person: REAL_NAME,
  body: `${REAL_NAME} asked for a reply to ${REAL_EMAIL}.`,
};

const emptyStores = (): ExecutionContext['stores'] => ({
  vault: {},
  config: {},
  context: { raw: structuredClone(RAW_PII) },
  meta: {},
  step: {},
});

const noopIngredientExecutor: IngredientExecutor = async () => null;

const piiRenderRecipe = (
  render: RecipeDefinition['output']['render'] = [{ type: 'copyable', source: 'step.protect' }],
): RecipeDefinition => ({
  recipe_id: 'd-167-p4-slice3-output-restore',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'PII output restore',
    description: 'protect without explicit restore',
    author: 'test',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'protect',
      transform: 'pii-protect',
      data: '{{context.raw}}',
      fields: [
        { path: 'from', kind: 'email' },
        { path: 'person', kind: 'name' },
        { path: 'body', kind: 'content' },
      ],
    },
  ],
  output: { render },
});

const makeCtx = (
  recipe: RecipeDefinition,
  onProgress?: (event: ProgressEvent) => void,
): ExecutionContext => ({
  recipe,
  stores: emptyStores(),
  ingredientExecutor: noopIngredientExecutor,
  ...(onProgress ? { onProgress } : {}),
});

const stringify = (value: unknown): string => JSON.stringify(value);

describe('D-167 P4 Slice 3 — engine restores render output aliases', () => {
  it('restores final output render data when pii-restore is omitted', async () => {
    const result = await executeRecipe(makeCtx(piiRenderRecipe()));

    expect(result.success).toBe(true);
    expect(result.output.render).toHaveLength(1);
    expect(result.output.sidebar).toBe(result.output.render);

    const data = result.output.render[0].data as {
      aliased: typeof RAW_PII;
      ledger_handle: string;
    };

    // Mutation-sensitive: deleting the piiStore argument from the final
    // resolveOutputRender call leaves these deterministic aliases in user output.
    expect(data.aliased.from).toBe(REAL_EMAIL);
    expect(data.aliased.person).toBe(REAL_NAME);
    expect(data.aliased.body).toBe(RAW_PII.body);
    expect(typeof data.ledger_handle).toBe('string');
    expect(stringify(data)).not.toContain(EMAIL_ALIAS);
    expect(stringify(data)).not.toContain(NAME_ALIAS);
  });

  it('restores progressive render_ready data when pii-restore is omitted', async () => {
    const events: ProgressEvent[] = [];
    const result = await executeRecipe(makeCtx(piiRenderRecipe(), (event) => {
      events.push(event);
    }));
    const renderReady = events.filter(
      (event): event is Extract<ProgressEvent, { type: 'render_ready' }> =>
        event.type === 'render_ready',
    );

    expect(result.success).toBe(true);
    expect(renderReady.length).toBeGreaterThan(0);

    for (const event of renderReady) {
      const data = event.render[0].data as { aliased: typeof RAW_PII };
      // Mutation-sensitive: omitting piiStore from the progressive resolveOutputRender
      // call restores final output but leaks aliases in render_ready.
      expect(data.aliased.from).toBe(REAL_EMAIL);
      expect(data.aliased.person).toBe(REAL_NAME);
      expect(data.aliased.body).toBe(RAW_PII.body);
      expect(stringify(event.render[0].data)).not.toContain(EMAIL_ALIAS);
      expect(stringify(event.render[0].data)).not.toContain(NAME_ALIAS);
    }
  });

  it('does not restore recipe-static render type or label strings', async () => {
    const staticLabel = `Static recipe label keeps ${NAME_ALIAS} and ${EMAIL_ALIAS}`;
    const result = await executeRecipe(makeCtx(piiRenderRecipe([
      { type: 'copyable', source: 'step.protect', label: staticLabel },
    ])));

    expect(result.success).toBe(true);
    expect(result.output.render[0].type).toBe('copyable');
    expect(result.output.render[0].label).toBe(staticLabel);

    const data = result.output.render[0].data as { aliased: typeof RAW_PII };
    // Mutation-sensitive: restoring the whole render section instead of only
    // `data` rewrites the alias-looking static label above.
    expect(data.aliased.from).toBe(REAL_EMAIL);
    expect(data.aliased.person).toBe(REAL_NAME);
    expect(stringify(data)).not.toContain(EMAIL_ALIAS);
    expect(stringify(data)).not.toContain(NAME_ALIAS);
  });

  it('passes through non-PII render data unchanged', async () => {
    const rawOutput = {
      title: 'Quarterly plan',
      notes: [
        'pii.Person1 is ordinary recipe text here',
        'm1@d1.invalid is not an allocated alias in this run',
      ],
      count: 2,
    };
    const recipe: RecipeDefinition = {
      recipe_id: 'd-167-p4-slice3-non-pii-output',
      version: 1,
      ttl: 300,
      metadata: {
        name: 'Non-PII output',
        description: 'ordinary render output',
        author: 'test',
        supported_platforms: [],
      },
      variables: {},
      prefetch_steps: [],
      steps: [
        { id: 'raw', transform: 'coalesce', values: [rawOutput] },
      ],
      output: { render: [{ type: 'summary', source: 'step.raw' }] },
    };

    const result = await executeRecipe(makeCtx(recipe));

    // Mutation-sensitive: an over-eager restore path must not corrupt ordinary
    // output or alias-looking strings when no pii-protect step minted a ledger.
    expect(result.success).toBe(true);
    expect(result.output.render[0].data).toEqual(rawOutput);
  });
});
