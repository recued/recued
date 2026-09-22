import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutionContext, ExecutionResult } from '@recued/engine';
import {
  FILTER_CONFIG_KEY_NOT_ALLOWED,
  FILTER_INVOCATION_FORBIDDEN,
  FILTER_INVOCATION_STALE,
  RpcError,
  UNDECLARED_CONFIG_ARGUMENT,
  type ExecutionSource,
  type RecipeDefinition,
  type RecipeStep,
  type UndeclaredConfigArgumentDetails,
} from '@recued/contracts';
import { hashRecipe } from '@recued/recipes';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

/** D-222 Slice A — the wiring half of the declaration boundary.
 *
 *  § 6.1 requires the refusal to land BEFORE the namespace store is
 *  constructed, so an undeclared key cannot reach `config.*` even transiently.
 *  A test that only asserted "it throws" would pass just as well if the check
 *  ran late, so every negative case here also asserts `executeRecipe` was never
 *  reached.
 *
 *  ⚠ Be precise about what that proves: dispatch-not-reached shows the refusal
 *  precedes the RUN. It does NOT distinguish "before the store was built" from
 *  "after the store, before dispatch" — on a refused run nothing observes the
 *  store either way, so that placement is not externally testable. It is held by
 *  the call site (the check sits ~100 lines ahead of `createNamespaceStores`) and
 *  by the mutation probe, not by an assertion here. Don't read these tests as
 *  evidence of the stronger property.
 *
 *  The pure rule (own-keys, origin attribution, prototype shapes) is covered in
 *  `packages/contracts/src/__tests__/d-222-slice-a-declaration-boundary.test.ts`.
 *  This file covers only what the boundary adds: placement, the typed error, and
 *  the positive case that keeps it a guard rather than a blanket refusal. */

const executeRecipeMock = vi.hoisted(() => vi.fn());

vi.mock('@recued/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/engine')>();
  return { ...actual, executeRecipe: executeRecipeMock };
});

// Imported AFTER the hoisted `vi.mock` so the handler binds the mock.
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const RECIPE_ID = 'd-222-slice-a-declaration';

/** Transform-only fixture: no ingredient step, so no manifest lookup and
 *  nothing for a policy gate to deny. Declares exactly one variable, so
 *  "declared" and "undeclared" are both one key away. */
const buildRecipe = (): RecipeDefinition =>
  ({
    recipe_id: RECIPE_ID,
    version: 1,
    ttl: 60,
    metadata: {
      name: RECIPE_ID,
      description: 'Fixture for the D-222 Slice A declaration boundary.',
      author: 'test',
      supported_platforms: ['test'],
      tags: ['test'],
    },
    variables: { status: 'open' },
    prefetch_steps: [],
    steps: [
      { id: 'noop', transform: 'concat', values: ['a', 'b'] } as unknown as RecipeStep,
    ],
    output: { render: [] },
  }) as RecipeDefinition;

const makeDeps = (): ExecuteHandlerDeps => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(buildRecipe());
  return {
    recipeStore,
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    instanceId: 'd-222-slice-a-test',
  };
};

const FILTER_RECIPE_ID = 'd-222-filter-admission';
const buildFilterRecipe = (): RecipeDefinition => ({
  recipe_id: FILTER_RECIPE_ID,
  version: 1,
  ttl: 0,
  metadata: {
    name: 'D-222 filter admission',
    description: 'Stored output-filter admission fixture for D-222.',
    author: 'test',
    supported_platforms: [],
  },
  variables: {
    status: { label: 'Status', type: 'text', default: 'open' },
    cursor: '',
    allow_llm_upgrade: false,
    connection_selector: { label: 'Connection', type: 'connection', default: '' } as never,
  },
  prefetch_steps: [],
  steps: [{ id: 'rows', transform: 'coalesce', values: [{ rows: [] }] }],
  output: {
    render: [
      { type: 'table', source: 'step.rows' },
      {
        type: 'filter',
        source: 'step.rows',
        fields: ['status'],
        hidden: ['cursor'],
        submit: 'Search',
      },
    ],
  },
});

const EDIT_RECIPE_ID = 'd-222-table-edit-admission';
const buildEditRecipe = (): RecipeDefinition => ({
  recipe_id: EDIT_RECIPE_ID,
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Editable grid admission',
    description: 'Stored table.edit admission fixture.',
    author: 'test',
    supported_platforms: [],
  },
  variables: {
    lines: { label: 'Lines', type: 'array', default: [] } as never,
    other: { label: 'Other', type: 'text', default: '' },
  },
  prefetch_steps: [],
  steps: [{ id: 'rows', transform: 'coalesce', values: [{ rows: [] }] }],
  output: {
    render: [
      { type: 'summary', source: 'step.rows' },
      {
        type: 'table',
        source: 'step.rows',
        entity: 'order_item',
        edit: { into: 'lines', submit: 'Save lines' },
      } as never,
    ],
  },
});

const makeEditDeps = (): ExecuteHandlerDeps => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(buildEditRecipe());
  return {
    recipeStore,
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    instanceId: 'd-222-table-edit-test',
  };
};

const editInvocation = () => ({
  kind: 'output.table_edit' as const,
  recipe_hash: hashRecipe(buildEditRecipe()),
  section_index: 1,
});


const SELECT_RECIPE_ID = 'd-282-table-select-admission';
const buildSelectRecipe = (hidden?: string[]): RecipeDefinition => ({
  recipe_id: SELECT_RECIPE_ID,
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Selectable table admission',
    description: 'Stored table.select admission fixture.',
    author: 'test',
    supported_platforms: [],
  },
  variables: {
    picked: { label: 'Picked', type: 'array', default: [] } as never,
    other: { label: 'Other', type: 'text', default: '' },
  },
  prefetch_steps: [],
  steps: [{ id: 'rows', transform: 'coalesce', values: [{ rows: [] }] }],
  output: {
    render: [
      { type: 'summary', source: 'step.rows' },
      {
        type: 'table',
        source: 'step.rows',
        select: {
          into: 'picked',
          submit: 'Act on selected',
          id_field: 'id',
          ...(hidden === undefined ? {} : { hidden }),
        },
      } as never,
    ],
  },
});

const makeSelectDeps = (recipe = buildSelectRecipe()): ExecuteHandlerDeps => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  return {
    recipeStore,
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    instanceId: 'd-282-table-select-test',
  };
};

const selectInvocation = (recipe = buildSelectRecipe()) => ({
  kind: 'output.table_select' as const,
  recipe_hash: hashRecipe(recipe),
  section_index: 1,
});

const makeFilterDeps = (): ExecuteHandlerDeps => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(buildFilterRecipe());
  return {
    recipeStore,
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    instanceId: 'd-222-filter-test',
  };
};

const OWNER_SOURCE: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'owner',
  client_token_id: 'local-client',
};

const filterInvocation = () => ({
  kind: 'output.filter' as const,
  recipe_hash: hashRecipe(buildFilterRecipe()),
  section_index: 1,
});

const successResult = (): ExecutionResult => ({
  recipe_id: RECIPE_ID,
  recipe_hash: 'hash-d222a',
  success: true,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 0,
  validation_issues: [],
});

/** Dispatch with the given config and return the error, asserting that the
 *  engine was never reached. Fails loudly if the call SUCCEEDED, so a
 *  regression that stops refusing cannot read as a pass. */
const refusalFor = async (config: Record<string, unknown>): Promise<RpcError> => {
  let thrown: unknown;
  try {
    await handleExecute(makeDeps(), { recipe_id: RECIPE_ID, config });
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected the run to refuse, but it did not throw').toBeInstanceOf(RpcError);
  // The placement assertion: refusing after the namespace store was built would
  // still throw, and would still have copied the key into `config.*` first.
  expect(
    executeRecipeMock,
    'refused, but only AFTER dispatch — the check is past the namespace store',
  ).not.toHaveBeenCalled();
  return thrown as RpcError;
};

beforeEach(() => {
  executeRecipeMock.mockReset();
  executeRecipeMock.mockImplementation(async (_ctx: ExecutionContext) => successResult());
});

describe('D-222 Slice A — declaration check at the execute boundary', () => {
  it('refuses an undeclared wire key before dispatch', async () => {
    const err = await refusalFor({ staus: 'closed' });
    expect(err.code).toBe(UNDECLARED_CONFIG_ARGUMENT);
    expect(err.status).toBe(400);
  });

  it('carries the finding as typed details, not prose', async () => {
    const err = await refusalFor({ staus: 'closed' });
    const details = err.details as unknown as UndeclaredConfigArgumentDetails;
    expect(details.undeclared).toEqual([{ key: 'staus', origin: 'wire' }]);
    // `declared` lets a caller see what it could have sent instead.
    expect(details.declared).toEqual(['status']);
  });

  it('attributes a request key to the wire, not to a stored overlay', async () => {
    const err = await refusalFor({ typo: 1 });
    const details = err.details as unknown as UndeclaredConfigArgumentDetails;
    expect(details.undeclared[0]?.origin).toBe('wire');
  });

  it('reports every undeclared key, not just the first', async () => {
    const err = await refusalFor({ one: 1, two: 2 });
    const details = err.details as unknown as UndeclaredConfigArgumentDetails;
    expect(details.undeclared.map((u) => u.key)).toEqual(['one', 'two']);
  });

  // ── the positive cases ────────────────────────────────────────────────
  // A blanket refusal would pass every test above. These are the inputs that
  // would DO THE THING if the check were gone, so they are what makes it a
  // boundary rather than a wall — and they are what gate 8 asks for: the
  // owner's ordinary invocation still sets a declared key.

  it('admits a declared key and reaches the engine', async () => {
    const res = await handleExecute(makeDeps(), {
      recipe_id: RECIPE_ID,
      config: { status: 'closed' },
    });
    expect(executeRecipeMock).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(true);
  });

  it('passes the declared value through to the run', async () => {
    let captured: ExecutionContext | undefined;
    executeRecipeMock.mockImplementationOnce(async (ctx: ExecutionContext) => {
      captured = ctx;
      return successResult();
    });
    await handleExecute(makeDeps(), {
      recipe_id: RECIPE_ID,
      config: { status: 'closed' },
    });
    if (captured === undefined) throw new Error('engine was not reached');
    const stores = (captured as unknown as { stores?: { config?: Record<string, unknown> } }).stores;
    expect(stores?.config?.status).toBe('closed');
  });

  it('admits a run with no config at all', async () => {
    await handleExecute(makeDeps(), { recipe_id: RECIPE_ID });
    expect(executeRecipeMock).toHaveBeenCalledTimes(1);
  });

  it('admits an empty config object', async () => {
    await handleExecute(makeDeps(), { recipe_id: RECIPE_ID, config: {} });
    expect(executeRecipeMock).toHaveBeenCalledTimes(1);
  });

  it('refuses the undeclared key even when a declared one rides alongside', async () => {
    const err = await refusalFor({ status: 'closed', staus: 'closed' });
    const details = err.details as unknown as UndeclaredConfigArgumentDetails;
    expect(details.undeclared).toEqual([{ key: 'staus', origin: 'wire' }]);
  });
});

describe('D-222 Slice 3 — stored output-filter admission', () => {
  it('admits only the exact stored snapshot/block for the unrestricted local owner', async () => {
    let captured: ExecutionContext | undefined;
    executeRecipeMock.mockImplementationOnce(async (ctx: ExecutionContext) => {
      captured = ctx;
      return { ...successResult(), recipe_id: FILTER_RECIPE_ID };
    });

    await handleExecute(makeFilterDeps(), {
      recipe_id: FILTER_RECIPE_ID,
      config: { status: 'closed', cursor: 'next-page' },
      invocation: filterInvocation(),
      execution_source: OWNER_SOURCE,
    });

    expect(executeRecipeMock).toHaveBeenCalledTimes(1);
    expect(captured?.stores.config).toMatchObject({ status: 'closed', cursor: 'next-page' });
    expect(captured?.outputRecipeHash).toBe(filterInvocation().recipe_hash);
  });

  it.each([
    ['stale hash', { ...filterInvocation(), recipe_hash: 'stale' }],
    ['missing section', { ...filterInvocation(), section_index: 99 }],
    ['non-filter section', { ...filterInvocation(), section_index: 0 }],
    ['malformed descriptor', null as never],
  ])('refuses a %s before dispatch', async (_name, invocation) => {
    await expect(handleExecute(makeFilterDeps(), {
      recipe_id: FILTER_RECIPE_ID,
      config: { status: 'closed' },
      invocation,
      execution_source: OWNER_SOURCE,
    })).rejects.toMatchObject({ code: FILTER_INVOCATION_STALE, status: 409 });
    expect(executeRecipeMock).not.toHaveBeenCalled();
  });

  it.each(['allow_llm_upgrade', 'connection_selector'])(
    'refuses declared but block-unlisted key %s',
    async (key) => {
      await expect(handleExecute(makeFilterDeps(), {
        recipe_id: FILTER_RECIPE_ID,
        config: { [key]: key === 'allow_llm_upgrade' ? true : 'crm-main' },
        invocation: filterInvocation(),
        execution_source: OWNER_SOURCE,
      })).rejects.toMatchObject({
        code: FILTER_CONFIG_KEY_NOT_ALLOWED,
        status: 400,
        details: {
          rejected: [key],
          allowed: ['cursor', 'status'],
          section_index: 1,
        },
      });
      expect(executeRecipeMock).not.toHaveBeenCalled();
    },
  );

  it('re-derives the allowlist instead of trusting client-supplied descriptor fields', async () => {
    const forged = {
      ...filterInvocation(),
      fields: ['allow_llm_upgrade'],
      hidden: [],
    } as never;
    await expect(handleExecute(makeFilterDeps(), {
      recipe_id: FILTER_RECIPE_ID,
      config: { allow_llm_upgrade: true },
      invocation: forged,
      execution_source: OWNER_SOURCE,
    })).rejects.toMatchObject({ code: FILTER_CONFIG_KEY_NOT_ALLOWED });
  });

  it('keeps ordinary owner authority over a declared key unlisted by this filter', async () => {
    await handleExecute(makeFilterDeps(), {
      recipe_id: FILTER_RECIPE_ID,
      config: { allow_llm_upgrade: true },
      execution_source: OWNER_SOURCE,
    });
    expect(executeRecipeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps filter provenance out of the recipe namespace across owner, chat, and MCP calls', async () => {
    const seen: Record<string, unknown>[] = [];
    executeRecipeMock.mockImplementation(async (ctx: ExecutionContext) => {
      seen.push({ ...ctx.stores.config });
      return { ...successResult(), recipe_id: FILTER_RECIPE_ID };
    });
    const config = { status: 'closed', cursor: '' };

    await handleExecute(makeFilterDeps(), {
      recipe_id: FILTER_RECIPE_ID,
      config,
      invocation: filterInvocation(),
      execution_source: OWNER_SOURCE,
    });
    await handleExecute(makeFilterDeps(), {
      recipe_id: FILTER_RECIPE_ID,
      config,
      execution_source: {
        channel: 'chat', actor: 'user_self', chat_session_id: 'chat', user_id: 'owner',
      },
    });
    await handleExecute(makeFilterDeps(), {
      recipe_id: FILTER_RECIPE_ID,
      config,
      execution_source: {
        channel: 'mcp',
        actor: 'contracted_user',
        agent_id: 'agent',
        tool_call_id: 'call',
        mcp_token_id: 'token',
        contract_id: 'token',
      },
      contract_snapshot: {
        contract_id: 'token',
        contract_version: 'v1',
        allowed_tools: [],
        approval_required: [],
        scope_restrictions: [],
        resolved_at: 1,
      },
    });

    expect(seen).toEqual([config, config, config]);
    expect(seen.every((row) => !Object.prototype.hasOwnProperty.call(row, 'invocation'))).toBe(true);
  });

  it('refuses inline, non-owner, contract-bearing, and source-less filter modes', async () => {
    const cases = [
      {
        recipe: buildFilterRecipe(),
        config: { status: 'closed' },
        invocation: filterInvocation(),
        execution_source: OWNER_SOURCE,
      },
      {
        recipe_id: FILTER_RECIPE_ID,
        config: { status: 'closed' },
        invocation: filterInvocation(),
        execution_source: {
          channel: 'chat', actor: 'user_self', chat_session_id: 'chat', user_id: 'owner',
        } as ExecutionSource,
      },
      {
        recipe_id: FILTER_RECIPE_ID,
        config: { status: 'closed' },
        invocation: filterInvocation(),
        execution_source: { ...OWNER_SOURCE, contract_id: 'restricted' },
      },
      {
        recipe_id: FILTER_RECIPE_ID,
        config: { status: 'closed' },
        invocation: filterInvocation(),
      },
    ];
    for (const request of cases) {
      executeRecipeMock.mockClear();
      await expect(handleExecute(makeFilterDeps(), request)).rejects.toMatchObject({
        code: FILTER_INVOCATION_FORBIDDEN,
        status: 403,
      });
      expect(executeRecipeMock).not.toHaveBeenCalled();
    }
  });

  it('omits resolved filter output for a non-owner ordinary caller', async () => {
    executeRecipeMock.mockImplementationOnce(async () => ({
      ...successResult(),
      recipe_id: FILTER_RECIPE_ID,
      output: {
        render: [
          { type: 'table', data: { rows: [] } },
          {
            type: 'filter',
            data: { rows: [] },
            filter: {
              ...filterInvocation(),
              fields: ['status'],
              hidden: ['cursor'],
              submit: 'Search',
              definitions: {},
              values: {},
            },
          },
        ],
        sidebar: [
          { type: 'filter', data: {}, filter: undefined },
        ],
      },
    }));
    const result = await handleExecute(makeFilterDeps(), { recipe_id: FILTER_RECIPE_ID });
    expect(result.output.render.map((section) => section.type)).toEqual(['table']);
    expect(result.output.sidebar).toEqual([]);
  });

  it('retains resolved filter output for an unrestricted owner caller', async () => {
    executeRecipeMock.mockImplementationOnce(async () => ({
      ...successResult(),
      recipe_id: FILTER_RECIPE_ID,
      output: {
        render: [{ type: 'filter', data: {}, filter: undefined }],
        sidebar: [{ type: 'filter', data: {}, filter: undefined }],
      },
    }));
    const result = await handleExecute(makeFilterDeps(), {
      recipe_id: FILTER_RECIPE_ID,
      execution_source: OWNER_SOURCE,
    });
    expect(result.output.render.map((section) => section.type)).toEqual(['filter']);
    expect(result.output.sidebar.map((section) => section.type)).toEqual(['filter']);
  });

  // ⛔ THE DRIFT CASE. The audience projection and filter admission are two
  // callers of one rule — "the unrestricted local owner" — and they disagreed:
  // admission refused a `user_self` caller carrying a `contract_snapshot`, while
  // the projection tested only `actor` + contract-in-source and handed that same
  // caller the block's declarations and effective config values. Half of one rule
  // enforced on each side. Both now share `isUnrestrictedLocalOwner`.
  it('omits resolved filter output for a user_self caller carrying a contract snapshot', async () => {
    executeRecipeMock.mockImplementationOnce(async () => ({
      ...successResult(),
      recipe_id: FILTER_RECIPE_ID,
      output: {
        render: [
          { type: 'table', data: {} },
          { type: 'filter', data: {}, filter: undefined },
        ],
        sidebar: [{ type: 'filter', data: {}, filter: undefined }],
      },
    }));
    const result = await handleExecute(makeFilterDeps(), {
      recipe_id: FILTER_RECIPE_ID,
      execution_source: OWNER_SOURCE,
      contract_snapshot: { contract_id: 'contract-restricted' } as never,
    });
    expect(result.output.render.map((section) => section.type)).toEqual(['table']);
    expect(result.output.sidebar).toEqual([]);
  });

  // The same caller cannot submit one either — the two sides now agree in BOTH
  // directions, which is the property that was missing.
  it('refuses a filter submit from a user_self caller carrying a contract snapshot', async () => {
    let thrown: unknown;
    try {
      await handleExecute(makeFilterDeps(), {
        recipe_id: FILTER_RECIPE_ID,
        execution_source: OWNER_SOURCE,
        contract_snapshot: { contract_id: 'contract-restricted' } as never,
        invocation: filterInvocation(),
        config: { status: 'open' },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RpcError);
    expect((thrown as RpcError).code).toBe(FILTER_INVOCATION_FORBIDDEN);
    expect((thrown as RpcError).status).toBe(403);
  });
});

describe('an editable table submits through the same gate as a filter', () => {
  it('admits the ONE variable the section declared', async () => {
    let captured: ExecutionContext | undefined;
    executeRecipeMock.mockImplementationOnce(async (ctx: ExecutionContext) => {
      captured = ctx;
      return { ...successResult(), recipe_id: EDIT_RECIPE_ID };
    });

    await handleExecute(makeEditDeps(), {
      recipe_id: EDIT_RECIPE_ID,
      config: { lines: [{ description: 'Labour', quantity: '2' }] },
      invocation: editInvocation(),
      execution_source: OWNER_SOURCE,
    });

    expect(executeRecipeMock).toHaveBeenCalledTimes(1);
    expect(captured?.stores.config).toMatchObject({
      lines: [{ description: 'Labour', quantity: '2' }],
    });
  });

  it('admits a hidden variable and dispatches it into config', async () => {
    // ⛔ The isolating pair for the test below: the SAME key, the SAME recipe
    // variable, refused when the section does not name it and admitted when it
    // does. Without this pair, a gate that admitted everything and a gate that
    // read `hidden` are indistinguishable.
    //
    // Why it matters: a submit is a fresh run of the whole recipe with only what
    // the grid sends. Before `hidden`, every other variable fell to its DEFAULT
    // — `collect-rent` reverted a 10-tenancy limit to 200 and re-rendered rows
    // the grid had never shown.
    const withHidden = () => {
      const recipe = buildEditRecipe() as unknown as {
        output: { render: Array<{ edit?: Record<string, unknown> }> };
      };
      recipe.output.render[1]!.edit!.hidden = ['other'];
      return recipe as never;
    };
    const store = createRecipeStore('/nonexistent');
    store.register(withHidden());
    const deps = {
      recipeStore: store,
      executorConfig: { manifests: createManifestRegistry('/nonexistent') },
      baseVault: {},
      instanceId: 'd-222-table-edit-hidden',
    } as ExecuteHandlerDeps;

    let captured: ExecutionContext | undefined;
    executeRecipeMock.mockImplementationOnce(async (ctx: ExecutionContext) => {
      captured = ctx;
      return successResult();
    });
    await handleExecute(deps, {
      recipe_id: EDIT_RECIPE_ID,
      config: { lines: [{ description: 'Labour' }], other: 'carried' },
      invocation: {
        kind: 'output.table_edit' as const,
        recipe_hash: hashRecipe(withHidden()),
        section_index: 1,
      },
      execution_source: OWNER_SOURCE,
    } as never);

    if (captured === undefined) throw new Error('engine was not reached');
    const config = (captured as unknown as { stores?: { config?: Record<string, unknown> } })
      .stores?.config;
    expect(config).toMatchObject({
      lines: [{ description: 'Labour' }],
      other: 'carried',
    });
  });

  it('refuses a DECLARED variable the grid did not name', async () => {
    // ⛔ The bound is the section's own `into`, not the recipe's variable list.
    // A grid that could submit any declared key would be a general write
    // channel wearing a table's clothes.
    await expect(handleExecute(makeEditDeps(), {
      recipe_id: EDIT_RECIPE_ID,
      config: { other: 'smuggled' },
      invocation: editInvocation(),
      execution_source: OWNER_SOURCE,
    })).rejects.toMatchObject({
      code: FILTER_CONFIG_KEY_NOT_ALLOWED,
      status: 400,
      details: { rejected: ['other'], allowed: ['lines'] },
    });
    expect(executeRecipeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['stale hash', { ...editInvocation(), recipe_hash: 'stale' }],
    ['missing section', { ...editInvocation(), section_index: 99 }],
    ['a section that is not a table', { ...editInvocation(), section_index: 0 }],
  ])('refuses %s before dispatch', async (_name, invocation) => {
    await expect(handleExecute(makeEditDeps(), {
      recipe_id: EDIT_RECIPE_ID,
      config: { lines: [] },
      invocation,
      execution_source: OWNER_SOURCE,
    })).rejects.toMatchObject({ code: FILTER_INVOCATION_STALE, status: 409 });
    expect(executeRecipeMock).not.toHaveBeenCalled();
  });

  it('refuses a table_edit invocation aimed at a READ-ONLY table', async () => {
    // ⛔ The one a shared gate could get wrong: the section IS a table, so a
    // type check alone passes. Without `edit` there is no declared target, and
    // admitting it would let a grid be invented over any table in the recipe.
    const deps = makeFilterDeps();
    await expect(handleExecute(deps, {
      recipe_id: FILTER_RECIPE_ID,
      config: { status: 'x' },
      invocation: {
        kind: 'output.table_edit' as const,
        recipe_hash: hashRecipe(buildFilterRecipe()),
        section_index: 0,
      },
      execution_source: OWNER_SOURCE,
    })).rejects.toMatchObject({ code: FILTER_INVOCATION_STALE, status: 409 });
    expect(executeRecipeMock).not.toHaveBeenCalled();
  });

  it('refuses an invocation kind nobody declared', async () => {
    // ⚠ Added after a mutation SURVIVED: removing the kind check changed
    // nothing red, because every test named a REAL kind. An unknown kind must
    // not fall through to whichever branch happens to be last — the gate
    // admits two kinds and refuses the rest by name.
    // ⛔ Aimed at a real FILTER section on purpose. Pointed at a table it
    // would be refused by the section-type check whether the kind check
    // existed or not — a mutant survived exactly that way. This is the input
    // that SUCCEEDS if the kind check is gone.
    await expect(handleExecute(makeFilterDeps(), {
      recipe_id: FILTER_RECIPE_ID,
      config: { status: 'closed' },
      invocation: { ...filterInvocation(), kind: 'output.something_else' } as never,
      execution_source: OWNER_SOURCE,
    })).rejects.toMatchObject({ code: FILTER_INVOCATION_STALE, status: 409 });
    expect(executeRecipeMock).not.toHaveBeenCalled();
  });

  it('still refuses a non-owner, exactly as the filter path does', async () => {
    await expect(handleExecute(makeEditDeps(), {
      recipe_id: EDIT_RECIPE_ID,
      config: { lines: [] },
      invocation: editInvocation(),
      execution_source: { ...OWNER_SOURCE, channel: 'mcp' } as never,
    })).rejects.toMatchObject({ status: 403 });
    expect(executeRecipeMock).not.toHaveBeenCalled();
  });
});


/** D-282 B6 — the THIRD kind through the same gate.
 *
 *  ⛔⛔ THE POINT OF WIDENING THE EXISTING BLOCK RATHER THAN WRITING A FOURTH
 *  COPY: the four checks a submission passes (owner-only, no inline recipe,
 *  hash still matches, section still declares the control) are identical for a
 *  filter, a grid and a selection. Three copies is three chances for one of
 *  them to stop checking something the others gained. These tests re-ask every
 *  one of them for the new kind rather than assuming the shared block covers
 *  it — a shared block only covers what actually routes through it. */
describe('a selectable table submits through the same gate as a filter', () => {
  it('admits the ids under the variable the section declared', async () => {
    let captured: ExecutionContext | undefined;
    executeRecipeMock.mockImplementationOnce(async (ctx: ExecutionContext) => {
      captured = ctx;
      return successResult();
    });
    await handleExecute(makeSelectDeps(), {
      recipe_id: SELECT_RECIPE_ID,
      config: { picked: ['doc_1', 'doc_2'] },
      invocation: selectInvocation(),
      execution_source: OWNER_SOURCE,
    } as never);
    const config = (captured as unknown as { stores?: { config?: Record<string, unknown> } })
      .stores?.config;
    expect(config).toMatchObject({ picked: ['doc_1', 'doc_2'] });
  });

  it('admits a variable the section named hidden, and only that one', async () => {
    const recipe = buildSelectRecipe(['other']);
    let captured: ExecutionContext | undefined;
    executeRecipeMock.mockImplementationOnce(async (ctx: ExecutionContext) => {
      captured = ctx;
      return successResult();
    });
    await handleExecute(makeSelectDeps(recipe), {
      recipe_id: SELECT_RECIPE_ID,
      config: { picked: ['doc_1'], other: 'carried' },
      invocation: selectInvocation(recipe),
      execution_source: OWNER_SOURCE,
    } as never);
    const config = (captured as unknown as { stores?: { config?: Record<string, unknown> } })
      .stores?.config;
    expect(config).toMatchObject({ picked: ['doc_1'], other: 'carried' });
  });

  it('refuses a DECLARED variable the selection did not name', async () => {
    // The bound is the SECTION's `into` (+ `hidden`), not the recipe's variable
    // list — the same rule the grid gets, for the same reason.
    await expect(handleExecute(makeSelectDeps(), {
      recipe_id: SELECT_RECIPE_ID,
      config: { other: 'smuggled' },
      invocation: selectInvocation(),
      execution_source: OWNER_SOURCE,
    })).rejects.toMatchObject({
      code: FILTER_CONFIG_KEY_NOT_ALLOWED,
      status: 400,
      details: { rejected: ['other'], allowed: ['picked'] },
    });
    expect(executeRecipeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['stale hash', { ...selectInvocation(), recipe_hash: 'stale' }],
    ['missing section', { ...selectInvocation(), section_index: 99 }],
    ['a section that is not a table', { ...selectInvocation(), section_index: 0 }],
  ])('refuses %s before dispatch', async (_name, invocation) => {
    await expect(handleExecute(makeSelectDeps(), {
      recipe_id: SELECT_RECIPE_ID,
      config: { picked: [] },
      invocation,
      execution_source: OWNER_SOURCE,
    })).rejects.toMatchObject({ code: FILTER_INVOCATION_STALE, status: 409 });
    expect(executeRecipeMock).not.toHaveBeenCalled();
  });

  it('refuses a table_select invocation aimed at a table that declares no select', async () => {
    // ⛔ The one a shared gate gets wrong by being generous: the section IS a
    // table, so a type check alone passes. Without `select` there is no
    // declared target, and admitting it would let a bulk action be invented
    // over ANY table in the recipe — including a read-only board.
    await expect(handleExecute(makeEditDeps(), {
      recipe_id: EDIT_RECIPE_ID,
      config: { lines: [] },
      invocation: {
        kind: 'output.table_select' as const,
        recipe_hash: hashRecipe(buildEditRecipe()),
        section_index: 1,
      },
      execution_source: OWNER_SOURCE,
    })).rejects.toMatchObject({ code: FILTER_INVOCATION_STALE, status: 409 });
    expect(executeRecipeMock).not.toHaveBeenCalled();
  });

  it('refuses a selection submitted by anyone but the unrestricted local owner', async () => {
    await expect(handleExecute(makeSelectDeps(), {
      recipe_id: SELECT_RECIPE_ID,
      config: { picked: ['doc_1'] },
      invocation: selectInvocation(),
      execution_source: { ...OWNER_SOURCE, channel: 'mcp' },
    } as never)).rejects.toMatchObject({ code: FILTER_INVOCATION_FORBIDDEN, status: 403 });
    expect(executeRecipeMock).not.toHaveBeenCalled();
  });
});
