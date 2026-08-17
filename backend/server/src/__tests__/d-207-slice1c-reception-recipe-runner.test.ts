/** D-207 slice 1c — the GENERAL gated reception recipe runner.
 *
 *  Replaces the shape D-200 shipped: the ONLY raw `executeRecipe` in the server, which
 *  bypassed the Gateway, the contract, the actor and the run row — and was "safe" solely
 *  because its recipe profile was crippled to the point of being unable to dispatch a
 *  single ingredient. That safety and that narrowness were the same property.
 *
 *  Here safety comes from the GATE, so the profile can be WIDE. These pin the four things
 *  that make that true. */

import { describe, expect, it, vi } from 'vitest';

import type {
  ContractDefinition,
  DoorExecutionPolicy,
  RecipeDefinition,
} from '@recued/contracts';

import { createReceptionRecipeRunner } from '../reception-recipe-runner.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';

const NOW = () => 1_000;

const completed = {
  success: true,
  output: { render: [{ type: 'text', data: 'ok' }], sidebar: [] },
  errors: [],
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

const harness = (opts?: {
  contract_id?: string | null;
  revoked?: boolean;
  execute?: unknown;
  maxConcurrentRunsGlobal?: number;
  maxConcurrentRunsPerEndpoint?: number;
  /** The installed dish's `config_overlay` — what `reception-door-bind` derived the door's
   *  capability from. `undefined` models a recipe with no install config at all. */
  config?: Record<string, unknown>;
  recipe?: RecipeDefinition | null;
  policy?: DoorExecutionPolicy | null;
  scope?: ContractDefinition['scope'];
  door_types?: ContractDefinition['door_types'];
  enforceAuthority?: boolean;
}) => {
  const contractId = opts?.contract_id === undefined ? 'door_1' : opts.contract_id;
  const def = {
    contract_id: 'door_1',
    status: 'active',
    minted_at: NOW(),
    door_types: opts?.door_types ?? ['reception'],
    scope: opts?.scope ?? { operation_ids: ['core.mail.send'], ingredient_ids: ['mail-send'] },
    ...(opts?.policy === null
      ? {}
      : { door_execution_policy: opts?.policy ?? { max_steps: 64, allow_ai: false } }),
    ...(opts?.revoked === true ? { revoked_at: NOW() } : {}),
  } as unknown as ContractDefinition;

  const definitionStore = { get: (id: string) => (id === 'door_1' ? def : null) } as unknown as ContractDefinitionStore;
  const pairStore = {
    findByEndpoint: () => ({
      endpoint_id: 'ep1',
      binding: { recipe_id: 'lead-capture' },
      contract_id: contractId,
    }),
  } as unknown as ReceptionIntakeRecipePairStore;

  const handleExecute = vi.fn(async () =>
    opts?.execute ?? completed,
  );
  // Inject the REAL runner with a spied handleExecute so we assert what it HANDS THE GATE,
  // not a re-implementation of the gate.
  const executeDeps = { __spy: handleExecute } as never;
  // The SAME resolution `reception-door-bind` mints the door from. A harness that let these
  // two diverge could not catch the bug this dep exists to close.
  const resolveConfig = vi.fn((_recipeId: string) => opts?.config);
  const resolveRecipe = vi.fn((_recipeId: string) => opts?.recipe === undefined
    ? ({
        prefetch_steps: [],
        steps: [{ id: 'normalize', transform: 'default' }],
        trigger_steps: [],
      } as unknown as RecipeDefinition)
    : opts.recipe);
  return {
    definitionStore,
    pairStore,
    executeDeps,
    handleExecute,
    resolveConfig,
    resolveRecipe,
    resolveIngredientKind: () => 'http',
    ...(opts?.enforceAuthority === true
      ? {
          resolveDoorRecipe: (value: RecipeDefinition) => ({ ok: true as const, recipe: value }),
          resolveOp: (slug: string, operation: string) =>
            slug === 'crm-catalog' && operation === 'deal.search'
              ? ['recued-core.crm.deal.search']
              : [],
        }
      : {}),
    now: NOW,
    ...(opts?.maxConcurrentRunsGlobal === undefined
      ? {}
      : { maxConcurrentRunsGlobal: opts.maxConcurrentRunsGlobal }),
    ...(opts?.maxConcurrentRunsPerEndpoint === undefined
      ? {}
      : { maxConcurrentRunsPerEndpoint: opts.maxConcurrentRunsPerEndpoint }),
  };
};

/** The runner imports `handleExecute` directly, so spy at the module boundary. */
vi.mock('../execute-handler.js', async (orig) => {
  const actual = await orig<typeof import('../execute-handler.js')>();
  return {
    ...actual,
    handleExecute: (deps: { __spy?: (...a: unknown[]) => unknown }, req: unknown, opts: unknown) =>
      (deps.__spy as (...a: unknown[]) => unknown)(deps, req, opts),
  };
});

const run = (h: ReturnType<typeof harness>) =>
  createReceptionRecipeRunner(h).run({
    endpoint_id: 'ep1',
    submission_id: 'sub_1',
    submission: { email: 'v@example.com', note: 'hi' },
  });

const runInput = (endpoint_id: string, submission_id: string) => ({
  endpoint_id,
  submission_id,
  submission: { email: 'v@example.com', note: 'hi' },
});

describe('D-207 slice 1c — the runner goes THROUGH the gate, not around it', () => {
  it('dispatches through handleExecute with an ANONYMOUS source carrying the door contract', async () => {
    const h = harness();
    await run(h);
    const [, req] = h.handleExecute.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    const src = (req as { execution_source: Record<string, unknown> }).execution_source;
    // The actor stays `anonymous` — the truth. `contracted_user` would render as an AGENT
    // assertion and launder the provenance of every row the recipe writes.
    expect(src).toMatchObject({
      channel: 'reception',
      actor: 'anonymous',
      reception_id: 'ep1',
      contract_id: 'door_1',
    });
    expect((req as { trigger_source: string }).trigger_source).toBe('reception');
  });

  it('carries a ContractSnapshot — NOT optional: a contract-bearing source without one THROWS', async () => {
    const h = harness();
    await run(h);
    const [, req] = h.handleExecute.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    const snap = (req as { contract_snapshot: { allowed_tools: string[] } }).contract_snapshot;
    // The tool axis, fed from the SAME derivation the mint wrote its grant rows from.
    expect(snap.allowed_tools).toEqual(['mail-send']);
  });

  it('the run id is anchored on the submission — a re-drive collapses, it does not re-fire', async () => {
    const h = harness();
    await run(h);
    const [, , opts] = h.handleExecute.mock.calls[0] as unknown as [unknown, unknown, { run_id: string }];
    expect(opts.run_id).toBe('reception:sub_1');
  });

  it('the visitor\'s fields reach the recipe as context.reception_submission', async () => {
    const h = harness();
    await run(h);
    const [, req] = h.handleExecute.mock.calls[0] as unknown as [unknown, { context: Record<string, unknown> }];
    expect(req.context).toEqual({ reception_submission: { email: 'v@example.com', note: 'hi' } });
  });
});

/** ⛔ The bug this closes was LIVE and SILENT in landed slice-1c code.
 *
 *  `handleExecute` merges the install dish's `config_overlay` ONLY for a run with no
 *  `run_id` — a gate written for `pick`/`saga`, which pass a `run_id` together with a
 *  CAPTURED config, so for them "has a run_id" really does mean "brought its own config".
 *
 *  The reception runner passes a `run_id` for an unrelated reason (idempotency) and brings
 *  NO config, so it fell through every branch and dispatched with an empty one. Meanwhile
 *  `reception-door-bind` derives the door's op closure — including which CONNECTION each
 *  step uses — from exactly that config, mints the grant rows from it, and shows the owner
 *  the list as the consent moment. Bind and run were reading different worlds. */
describe('D-207 slice 3c — the run resolves the SAME config the door was minted from', () => {
  it('passes the install-dish config to the engine — it is NOT merged for us', async () => {
    // Deliberately NOT a `seller_offer_id`: this harness has no seller substrate, and a
    // config naming an offer on a server that cannot sell is a REFUSAL (slice 3c), not a
    // dispatch. The selling path has its own suite, driven through a real seller store.
    const h = harness({ config: { stripe_conn: 'stripe-live', notify: 'ops@example.com' } });
    await run(h);

    const [, req, opts] = h.handleExecute.mock.calls[0] as unknown as [
      unknown,
      { config?: Record<string, unknown> },
      { run_id?: string },
    ];

    // NON-VACUITY: the whole bug is that a `run_id` suppresses the engine's own merge. If
    // this run carried no `run_id`, the engine would merge the overlay itself and the
    // assertion below would pass with the fix fully disarmed.
    expect(opts.run_id).toBe('reception:sub_1');

    expect(req.config).toEqual({ stripe_conn: 'stripe-live', notify: 'ops@example.com' });
    expect(h.resolveConfig).toHaveBeenCalledWith('lead-capture');
  });

  it('an unconfigured recipe dispatches with no config key at all — never an empty object', async () => {
    // `{}` and "absent" are different to a merge. Sending `config: {}` would let a caller's
    // empty object win over a source the engine might otherwise supply.
    const h = harness({ config: undefined });
    await run(h);
    const [, req] = h.handleExecute.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect('config' in req).toBe(false);
  });
});

describe('D-207 slice 1c — outcomes', () => {
  it('completed -> returns the recipe OUTPUT (the render blocks Slice 2 will consume)', async () => {
    const h = harness();
    const r = await run(h);
    expect(r.kind).toBe('completed');
    if (r.kind === 'completed') expect(r.output.render).toEqual([{ type: 'text', data: 'ok' }]);
  });

  it('HELD is not a FAILURE — awaiting_approval is queued, not failed', async () => {
    // The run is durably PAUSED at the D-157 gate and lands in the D-173 Inbox. Conflating
    // this with a failure would either lie to the visitor or show them an error for the
    // system working exactly as designed.
    const h = harness({ execute: { success: false, awaiting_approval: true, errors: [] } });
    const r = await run(h);
    expect(r.kind).toBe('held');
  });

  it('D-234 § 234.4 — a PEER hold is HELD too, not a failure', async () => {
    // ⛔⛔ IT REPORTED `failed`, AND THE RUN WAS ALIVE. A paired recipe that asks a peer for
    // an approval pauses with `awaiting_peer` — durable, checkpointed, resumable — and this
    // classifier only knew `awaiting_approval`, so the visitor got a 503 for a run that was
    // waiting on a department head. Worse than the lie: `run_id` is anchored on the
    // SUBMISSION, so a visitor who believed the error and resubmitted minted a second run and
    // the peer was asked the same question twice.
    const h = harness({ execute: { success: false, awaiting_peer: true, errors: [] } });
    const r = await run(h);
    expect(r.kind).toBe('held');
  });

  it('a real failure is a FAILURE — the visitor must be told', async () => {
    // ⚠ The permitting case for the two above: a refusal that returned `held` for everything
    // would satisfy both hold tests while destroying the one distinction they exist to keep.
    const h = harness({ execute: { success: false, errors: ['boom'] } });
    const r = await run(h);
    expect(r.kind).toBe('failed');
  });

  it('NO DOOR -> does not run at all', async () => {
    // A pair with no minted contract would dispatch contract-free... except it cannot: the
    // source would be floored to PUBLIC_CONTRACT_ID, which grants nothing, so every op
    // hard-denies. Detect it up front rather than manufacture a failed run.
    const h = harness({ contract_id: null });
    const r = await run(h);
    expect(r.kind).toBe('no_door');
    expect(h.handleExecute).not.toHaveBeenCalled();
  });

  it('a REVOKED door stops the whole run before any runner-owned or engine effect', async () => {
    const h = harness({ revoked: true });
    await expect(run(h)).resolves.toMatchObject({
      kind: 'failed',
      errors: [expect.stringContaining('no longer active')],
    });
    expect(h.handleExecute).not.toHaveBeenCalled();
  });

  it('a contract for another door class cannot back a reception run', async () => {
    const h = harness({ door_types: ['webhook'] });
    await expect(run(h)).resolves.toMatchObject({ kind: 'failed' });
    expect(h.handleExecute).not.toHaveBeenCalled();
  });

  it('a legacy door with no execution policy fails before the engine runs', async () => {
    const h = harness({ policy: null });
    await expect(run(h)).resolves.toMatchObject({
      kind: 'failed',
      errors: [expect.stringContaining('re-bind this form')],
    });
    expect(h.handleExecute).not.toHaveBeenCalled();
  });

  it('AI fails before dispatch unless the persisted door records the owner opt-in', async () => {
    const aiRecipe = {
      prefetch_steps: [],
      steps: [{ id: 'generate', op: 'core.ai.generate' }],
      trigger_steps: [],
    } as unknown as RecipeDefinition;
    const denied = harness({ recipe: aiRecipe });
    await expect(run(denied)).resolves.toMatchObject({
      kind: 'failed',
      errors: [expect.stringContaining('AI-cost opt-in')],
    });
    expect(denied.handleExecute).not.toHaveBeenCalled();

    const admitted = harness({
      recipe: aiRecipe,
      policy: { max_steps: 64, allow_ai: true },
    });
    await expect(run(admitted)).resolves.toMatchObject({ kind: 'completed' });
    expect(admitted.handleExecute).toHaveBeenCalledTimes(1);
  });

  it('runtime recipe drift to foreach fails before dispatch even under a live policy', async () => {
    const h = harness({
      recipe: {
        prefetch_steps: [],
        steps: [{ id: 'fanout', ingredient: 'mail-send', foreach: '{{context.items}}' }],
        trigger_steps: [],
      } as unknown as RecipeDefinition,
    });
    await expect(run(h)).resolves.toMatchObject({
      kind: 'failed',
      errors: [expect.stringContaining('unbounded foreach')],
    });
    expect(h.handleExecute).not.toHaveBeenCalled();
  });

  it('account drift fails before execution under the still-pinned prior door', async () => {
    const h = harness({
      enforceAuthority: true,
      config: { crm: 'acct-new' },
      scope: {
        operation_ids: ['recued-core.crm.deal.search'],
        ingredient_ids: ['crm-catalog'],
        connection_names: ['acct-old'],
      },
      recipe: {
        prefetch_steps: [],
        steps: [{
          id: 'read',
          ingredient: 'crm-catalog',
          connection: '{{config.crm}}',
          input: { operation: 'deal.search', args: {} },
        }],
        trigger_steps: [],
      } as unknown as RecipeDefinition,
    });

    await expect(run(h)).resolves.toMatchObject({
      kind: 'failed',
      errors: [expect.stringContaining('authority changed')],
    });
    expect(h.handleExecute).not.toHaveBeenCalled();
  });
});

describe('D-207 public-run concurrency pressure', () => {
  it('singleflights one durable submission and releases it after settlement', async () => {
    const pending = deferred<unknown>();
    const h = harness({
      execute: pending.promise,
      maxConcurrentRunsGlobal: 1,
      maxConcurrentRunsPerEndpoint: 1,
    });
    const runner = createReceptionRecipeRunner(h);
    const input = runInput('ep1', 'sub_shared');

    const first = runner.run(input);
    const duplicate = runner.run(input);
    expect(duplicate).toBe(first);
    expect(h.handleExecute).toHaveBeenCalledTimes(1);

    pending.resolve(completed);
    await expect(Promise.all([first, duplicate])).resolves.toHaveLength(2);

    // Singleflight is live-only. A later source-driven replay re-enters the
    // durable run id and lets handleExecute apply its normal replay semantics.
    await expect(runner.run(input)).resolves.toMatchObject({ kind: 'completed' });
    expect(h.handleExecute).toHaveBeenCalledTimes(2);
  });

  it('fails fast at per-endpoint and global ceilings, then reuses released slots', async () => {
    const pending = deferred<unknown>();
    const h = harness({
      execute: pending.promise,
      maxConcurrentRunsGlobal: 2,
      maxConcurrentRunsPerEndpoint: 1,
    });
    const runner = createReceptionRecipeRunner(h);

    const endpointOne = runner.run(runInput('ep1', 'sub_1'));
    const endpointOverflow = runner.run(runInput('ep1', 'sub_2'));
    expect(h.handleExecute).toHaveBeenCalledTimes(1);
    await expect(endpointOverflow).rejects.toMatchObject({
      code: 'reception_recipe_concurrency_limited',
      scope: 'endpoint',
    });

    const endpointTwo = runner.run(runInput('ep2', 'sub_3'));
    const globalOverflow = runner.run(runInput('ep3', 'sub_4'));
    expect(h.handleExecute).toHaveBeenCalledTimes(2);
    await expect(globalOverflow).rejects.toMatchObject({
      code: 'reception_recipe_concurrency_limited',
      scope: 'global',
    });

    pending.resolve(completed);
    await Promise.all([endpointOne, endpointTwo]);

    await expect(runner.run(runInput('ep3', 'sub_4'))).resolves.toMatchObject({
      kind: 'completed',
    });
    expect(h.handleExecute).toHaveBeenCalledTimes(3);
  });
});
