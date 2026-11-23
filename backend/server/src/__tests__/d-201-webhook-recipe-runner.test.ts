import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '@recued/contracts';
import type { AuditEntry } from '@recued/storage';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import {
  WebhookRunNotRestartedError,
  type WebhookRecipeRunRequest,
} from '../webhook-recipe-consumer.js';

const { handleExecute } = vi.hoisted(() => ({ handleExecute: vi.fn() }));
vi.mock('../execute-handler.js', () => ({ handleExecute }));

import { createExecuteWebhookRecipeRunner } from '../webhook-recipe-runner.js';
import type { HeldRunOutcome } from '../preflight-resumer.js';

const request = (): WebhookRecipeRunRequest => ({
  run_id: 'whr_0123456789abcdef0123456789abcdef',
  idempotency_key: 'whr_0123456789abcdef0123456789abcdef',
  recipe_id: 'webhook-recipe',
  publisher_id: 'publisher-1',
  context: {
    webhook: {
      kind: 'webhook',
      binding: 'events',
      event_ref: 'whe_event',
      delivery_ref: 'whd_delivery',
      event_id: 'whe_event',
      ingress_id: 'whi_ingress',
      profile_id: 'generic.raw-body-hmac-sha256.v1',
      transport_assurance: 'authenticated',
      source_truth_policy: 'delivery_payload_allowed',
      provider_event_id: null,
      provider_resource_id: null,
      provider_event_type: 'delivery',
      provider_occurred_at: null,
      received_at: 1,
      duplicate: false,
    },
  },
  // D-209 #1 W3 — an ANONYMOUS door dispatch; door-less here (unstamped trigger
  // row), so the runner builds no snapshot and the gate floors it.
  execution_source: {
    channel: 'webhook',
    actor: 'anonymous',
    vendor: 'generic',
    webhook_secret_id: 'whi_ingress',
  },
});

const anchor = (commit_status: AuditEntry['commit_status']): AuditEntry => ({
  run_id: request().run_id,
  recipe_id: request().recipe_id,
  recipe_hash: 'hash',
  started_at: 1,
  finished_at: 2,
  duration_ms: 1,
  commit_status,
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: 'webhook',
  instance_id: 'server',
});

const deps = (
  getAudit: () => Promise<AuditEntry | null>,
  resolveConfig: (recipeId: string) => Record<string, unknown> | undefined = () => undefined,
) => ({
  executeDeps: {
    recipeStore: {
      get: vi.fn(() => ({ recipe_id: 'webhook-recipe', version: 1, steps: [] })),
      getStored: vi.fn(() => ({
        recipe_id: 'webhook-recipe',
        publisher_id: 'publisher-1',
      })),
    },
  } as unknown as ExecuteHandlerDeps,
  auditLog: { get: vi.fn(getAudit) },
  resolveConfig: vi.fn(resolveConfig),
  // D-209 #1 W3 — no doors exist in this harness; a null-returning store
  // resolves any stamped door DEAD (fail-closed), matching a partial harness.
  definitionStore: { get: (_id: string) => null },
});

describe('D-201 Slices 5A/5B2A webhook recipe runner', () => {
  beforeEach(() => {
    handleExecute.mockReset();
  });

  it('reuses an already-succeeded run without executing again', async () => {
    const runner = createExecuteWebhookRecipeRunner(deps(async () => anchor('succeeded')));
    await expect(runner.run(request())).resolves.toBe('completed');
    expect(handleExecute).not.toHaveBeenCalled();
  });

  it('collapses concurrent calls for the same stable run id', async () => {
    let resolve!: (value: { success: boolean }) => void;
    handleExecute.mockReturnValue(new Promise((done) => { resolve = done; }));
    const runner = createExecuteWebhookRecipeRunner(deps(async () => null));
    const first = runner.run(request());
    const second = runner.run(request());
    expect(first).toBe(second);
    await Promise.resolve();
    await Promise.resolve();
    expect(handleExecute).toHaveBeenCalledTimes(1);
    resolve({ success: true });
    await expect(Promise.all([first, second])).resolves.toEqual([
      'completed',
      'completed',
    ]);
  });

  it('rejects a concurrent run-id collision with different webhook context', async () => {
    let resolve!: (value: { success: boolean }) => void;
    handleExecute.mockReturnValue(new Promise((done) => { resolve = done; }));
    const runner = createExecuteWebhookRecipeRunner(deps(async () => null));
    const first = runner.run(request());
    const colliding = request();
    colliding.context.webhook.event_id = 'whe_different_event';

    await expect(runner.run(colliding)).rejects.toThrow('concurrent run id collision');
    await Promise.resolve();
    await Promise.resolve();
    expect(handleExecute).toHaveBeenCalledTimes(1);
    resolve({ success: true });
    await expect(first).resolves.toBe('completed');
  });

  it('retries a failed anchor under the same internal run identity', async () => {
    handleExecute.mockResolvedValue({ success: true });
    const runner = createExecuteWebhookRecipeRunner(deps(async () => anchor('failed')));
    await runner.run(request());
    expect(handleExecute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipe_id: 'webhook-recipe',
        trigger_source: 'webhook',
        execution_source: request().execution_source,
      }),
      { run_id: request().run_id },
    );
  });

  it("passes its recipe's main dish's choice of connection to the run (D-320 3b)", async () => {
    handleExecute.mockResolvedValue({ success: true });
    const choice = { choices: { hubspot: 'hubspot-app' }, label: 'Main' };
    const runner = createExecuteWebhookRecipeRunner({
      ...deps(async () => null),
      resolveDishConnections: (recipeId: string) => (recipeId === 'webhook-recipe' ? choice : undefined),
    });
    await runner.run(request());
    expect(handleExecute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recipe_id: 'webhook-recipe' }),
      { run_id: request().run_id, dish_connections: choice },
    );
  });

  // D-209 #1 W3 — a door-stamped dispatch must reach handleExecute WITH its
  // door ContractSnapshot (a contract-bearing source with no snapshot throws at
  // the policy/preflight gates), resolved from the SAME definition store the
  // Gateway reads: live door → derived tool closure; dead / unknown door → EMPTY
  // allowlist (denies — fail-closed).
  //
  // ⛔⛔ THE AUTHORED CEILING IS NO LONGER THREADED HERE, AND THAT IS THE POINT
  // OF THE CHANGE THIS ASSERTION USED TO PIN. D-209's rule is *"an authored
  // ceiling is admissible only where a MACHINE delivers a payload to a
  // DETERMINISTIC PATH"* — and this runner dispatches an ARBITRARY user recipe
  // (`recipe_id: claim.recipe_id`), so the premise does not hold on it. With the
  // ceiling threaded, an outbound send crossed admission with NO preflight:
  // `admin` relaxes the `write`, and `liftOutboundSend` is `user_self`-scoped so
  // nothing re-raises it. Driven, with an A/B isolating the ceiling as the sole
  // cause, in `d-209-webhook-outbound-send-ceiling.test.ts`.
  // ⇒ The door KEEPS its minted `admin` (a true property of the door under
  // §1.4); this dispatch simply does not borrow it, and falls to the LOW ceiling
  // that schedule and reactive already sit on. `allowed_tools` is untouched —
  // this narrows APPROVAL, never ACCESS.
  it('threads a LIVE door\'s tool closure — but NOT its authored ceiling', async () => {
    handleExecute.mockResolvedValue({ success: true });
    const stamped = request();
    stamped.execution_source.contract_id = 'door-wh-1';
    const d = deps(async () => null);
    d.definitionStore = {
      get: (id: string) => (id === 'door-wh-1'
        ? {
            contract_id: 'door-wh-1',
            grant_kind: 'standing',
            status: 'active',
            door_types: ['webhook'],
            scope: { channels: ['webhook'], actors: ['anonymous'], ingredient_ids: ['mail-send'] },
            max_risk_without_approval: 'admin',
          } as never
        : null),
    };
    await createExecuteWebhookRecipeRunner(d).run(stamped);
    expect(handleExecute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        execution_source: expect.objectContaining({ contract_id: 'door-wh-1' }),
        contract_snapshot: expect.objectContaining({
          contract_id: 'door-wh-1',
          allowed_tools: ['mail-send'],
        }),
      }),
      { run_id: stamped.run_id },
    );
    // ⛔ AND ASSERT THE ABSENCE EXPLICITLY. `objectContaining` passes whether or
    // not the field is there, so dropping it from the matcher above proves
    // nothing on its own — the exact shape of a test that silently stops
    // covering what it was written for.
    const snapshot = (handleExecute.mock.calls[0]?.[1] as {
      contract_snapshot?: { max_risk_without_approval?: unknown };
    }).contract_snapshot;
    expect(snapshot?.max_risk_without_approval).toBeUndefined();
  });

  it('a NON-webhook door (wrong door_types) resolves DEAD — its ceiling cannot be borrowed across door classes', async () => {
    handleExecute.mockResolvedValue({ success: true });
    const stamped = request();
    stamped.execution_source.contract_id = 'door-reception';
    const d = deps(async () => null);
    d.definitionStore = {
      get: () => ({
        contract_id: 'door-reception',
        grant_kind: 'standing',
        status: 'active',
        door_types: ['reception'],
        scope: { channels: ['reception'], actors: ['anonymous'], ingredient_ids: ['form-render'] },
        max_risk_without_approval: 'admin',
      } as never),
    };
    await createExecuteWebhookRecipeRunner(d).run(stamped);
    const [, executeRequest] = handleExecute.mock.calls.at(-1)!;
    expect(executeRequest.contract_snapshot).toMatchObject({
      contract_id: 'door-reception',
      allowed_tools: [],
    });
    expect(executeRequest.contract_snapshot.max_risk_without_approval).toBeUndefined();
  });

  it('a dead/unknown door resolves an EMPTY snapshot (no tools, no ceiling) — fail-closed', async () => {
    handleExecute.mockResolvedValue({ success: true });
    const stamped = request();
    stamped.execution_source.contract_id = 'door-gone';
    await createExecuteWebhookRecipeRunner(deps(async () => null)).run(stamped);
    const [, executeRequest] = handleExecute.mock.calls.at(-1)!;
    expect(executeRequest.contract_snapshot).toMatchObject({
      contract_id: 'door-gone',
      allowed_tools: [],
    });
    expect(executeRequest.contract_snapshot.max_risk_without_approval).toBeUndefined();
  });

  it('a door-less request (unstamped trigger row) carries NO snapshot', async () => {
    handleExecute.mockResolvedValue({ success: true });
    await createExecuteWebhookRecipeRunner(deps(async () => null)).run(request());
    const [, executeRequest] = handleExecute.mock.calls.at(-1)!;
    expect(executeRequest.execution_source.contract_id).toBeUndefined();
    expect(executeRequest.contract_snapshot).toBeUndefined();
  });

  it('refuses account drift under a stamped door before re-entering execution', async () => {
    handleExecute.mockResolvedValue({ success: true });
    const concreteRecipe = {
      recipe_id: 'webhook-recipe',
      version: 1,
      prefetch_steps: [],
      steps: [{
        id: 'read',
        ingredient: 'crm-catalog',
        connection: '{{config.crm}}',
        input: { operation: 'deal.search', args: {} },
      }],
    };
    const base = deps(async () => null, () => ({ crm: 'acct-new' }));
    vi.mocked(base.executeDeps.recipeStore.get).mockReturnValue(concreteRecipe as never);
    const d = {
      ...base,
      resolveDoorRecipe: () => ({ ok: true as const, recipe: concreteRecipe as never }),
      resolveOp: (slug: string, operation: string) =>
        slug === 'crm-catalog' && operation === 'deal.search'
          ? ['recued-core.crm.deal.search']
          : [],
      definitionStore: {
        get: () => ({
          contract_id: 'door-1',
          status: 'active',
          minted_at: 1,
          door_types: ['webhook'],
          scope: {
            operation_ids: ['recued-core.crm.deal.search'],
            ingredient_ids: ['crm-catalog'],
            connection_names: ['acct-old'],
          },
        }),
      },
    };
    const stamped = request();
    stamped.execution_source.contract_id = 'door-1';

    await expect(createExecuteWebhookRecipeRunner(d as never).run(stamped))
      .rejects.toThrow('door authority changed');
    expect(handleExecute).not.toHaveBeenCalled();
  });

  it('runs nothing on an unstamped production-wired target, and says its door is missing', async () => {
    const d = {
      ...deps(async () => null),
      resolveDoorRecipe: (recipe: never) => ({ ok: true as const, recipe }),
    };

    // D-201 Slice 10U — not `terminal_non_success`, which the worker cancelled unseen.
    await expect(createExecuteWebhookRecipeRunner(d as never).run(request()))
      .resolves.toBe('door_missing');
    expect(handleExecute).not.toHaveBeenCalled();
  });

  it('runs nothing under a revoked production-wired door, not even a pure recipe, and says its door is closed', async () => {
    handleExecute.mockResolvedValue({ success: true });
    const d = {
      ...deps(async () => null),
      resolveDoorRecipe: (recipe: never) => ({ ok: true as const, recipe }),
      definitionStore: {
        get: () => ({
          contract_id: 'door-1',
          status: 'active',
          minted_at: 1,
          revoked_at: 2,
          door_types: ['webhook'],
          scope: {},
        }),
      },
      now: () => 3,
    };
    const stamped = request();
    stamped.execution_source.contract_id = 'door-1';

    await expect(createExecuteWebhookRecipeRunner(d as never).run(stamped))
      .resolves.toBe('door_closed');
    expect(handleExecute).not.toHaveBeenCalled();
  });

  // ⛔ D-207 3d·5 — the empty-config bug. `handleExecute` skips its install-dish
  // config merge for any run carrying a `run_id`, and this runner always carries
  // one, so the runner must resolve and pass the install config itself. Without
  // it `{{config.*}}` — including the provider connection — resolves to nothing.
  it('passes the resolved install config into execution', async () => {
    handleExecute.mockResolvedValue({ success: true });
    const d = deps(async () => null, () => ({ stripe: 'stripe-primary' }));
    const runner = createExecuteWebhookRecipeRunner(d);
    await expect(runner.run(request())).resolves.toBe('completed');
    expect(d.resolveConfig).toHaveBeenCalledWith('webhook-recipe');
    expect(handleExecute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ config: { stripe: 'stripe-primary' } }),
      { run_id: request().run_id },
    );
  });

  it('omits the config field entirely when the recipe has no install config', async () => {
    handleExecute.mockResolvedValue({ success: true });
    const runner = createExecuteWebhookRecipeRunner(deps(async () => null));
    await expect(runner.run(request())).resolves.toBe('completed');
    expect(handleExecute).toHaveBeenCalledTimes(1);
    expect(handleExecute.mock.calls[0]![1]).not.toHaveProperty('config');
  });

  it('hands an owner-approval pause back to the durable dispatch layer', async () => {
    handleExecute.mockResolvedValue({ success: false, awaiting_approval: true });
    const runner = createExecuteWebhookRecipeRunner(deps(async () => null));

    await expect(runner.run(request())).resolves.toBe('awaiting_approval');
  });

  it('reuses an already-paused anchor without re-entering execution', async () => {
    const runner = createExecuteWebhookRecipeRunner(
      deps(async () => anchor('awaiting_approval')),
    );

    await expect(runner.run(request())).resolves.toBe('awaiting_approval');
    expect(handleExecute).not.toHaveBeenCalled();
  });

  it('treats a durable policy denial as terminal instead of retrying it', async () => {
    const denied = anchor('failed');
    denied.errors = [{
      error_id: 'preflight-deny-fixture',
      code: 'RECIPE_POLICY_DENIED',
      message: 'User denied preflight approval.',
      severity: 'fatal',
      source: {
        recipe_id: denied.recipe_id,
        step_id: 'send',
        ingredient_slug: 'fixture.send',
      },
      details: {},
      timestamp: new Date(0).toISOString(),
      retryable: false,
    }];
    const runner = createExecuteWebhookRecipeRunner(deps(async () => denied));

    await expect(runner.run(request())).resolves.toBe('terminal_non_success');
    expect(handleExecute).not.toHaveBeenCalled();
  });

  // D-320 audit — a refusal under a door that a re-derive has since replaced is not
  // the delivery's: the retry's claim carries the new door, and the run goes again on
  // the same id. An owner's denial stays closed, whatever happened to the door since
  // (`details.denied_by`, written by the resumer): the owner said no.
  it.each([
    ['re-enters a refusal under a door since replaced', {}, 'completed'],
    ["never re-enters an owner's denial, though its door was replaced", { denied_by: 'owner' }, 'terminal_non_success'],
  ] as const)('%s', async (_label, details, expected) => {
    handleExecute.mockResolvedValue({ success: true });
    const door = (contract_id: string, revoked_at?: number) => ({
      contract_id,
      grant_kind: 'standing',
      status: 'active',
      minted_at: 1,
      ...(revoked_at !== undefined ? { revoked_at } : {}),
      door_types: ['webhook'],
      scope: { channels: ['webhook'], actors: ['anonymous'], ingredient_ids: ['fixture.send'] },
    } as never);
    const refused = anchor('failed');
    refused.execution_source = { ...request().execution_source, contract_id: 'door-old' } as never;
    refused.errors = [{
      error_id: 'refusal-fixture',
      code: 'RECIPE_POLICY_DENIED',
      message: 'refused',
      severity: 'fatal',
      source: { recipe_id: refused.recipe_id, step_id: 'send', ingredient_slug: 'fixture.send' },
      details: { ...details },
      timestamp: new Date(0).toISOString(),
      retryable: false,
    }];
    const d = {
      ...deps(async () => refused),
      definitionStore: {
        get: (id: string) => (id === 'door-old' ? door('door-old', 2) : id === 'door-new' ? door('door-new') : null),
      },
      now: () => 3,
    };
    const claimed = request();
    claimed.execution_source.contract_id = 'door-new';

    await expect(createExecuteWebhookRecipeRunner(d as never).run(claimed)).resolves.toBe(expected);
    expect(handleExecute).toHaveBeenCalledTimes(expected === 'completed' ? 1 : 0);
  });

  it.each(['cancelled', 'killed', 'in_doubt'] as const)(
    'closes an already-terminal %s anchor without retrying it',
    async (status) => {
      const runner = createExecuteWebhookRecipeRunner(deps(async () => anchor(status)));
      await expect(runner.run(request())).resolves.toBe('terminal_non_success');
      expect(handleExecute).not.toHaveBeenCalled();
    },
  );

  it('D-201 Slice 10E — runs a killed anchor again on its run id when the restart stopped it, and only then', async () => {
    handleExecute.mockResolvedValue({ success: true });
    const restarted = createExecuteWebhookRecipeRunner(deps(async () => anchor('killed')));
    await expect(restarted.run({ ...request(), resume_interrupted_run: true })).resolves.toBe('completed');
    expect(handleExecute).toHaveBeenCalledTimes(1);
    expect(handleExecute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ trigger_source: 'webhook' }),
      { run_id: request().run_id },
    );
    handleExecute.mockClear();
    // No mark: the owner's Stop, final as before.
    await expect(restarted.run(request())).resolves.toBe('terminal_non_success');
    // The mark re-enters a kill and nothing else.
    for (const status of ['cancelled', 'in_doubt'] as const) {
      const runner = createExecuteWebhookRecipeRunner(deps(async () => anchor(status)));
      await expect(runner.run({ ...request(), resume_interrupted_run: true }))
        .resolves.toBe('terminal_non_success');
    }
    for (const status of ['pending', 'running'] as const) {
      const runner = createExecuteWebhookRecipeRunner(deps(async () => anchor(status)));
      await expect(runner.run({ ...request(), resume_interrupted_run: true }))
        .rejects.toThrow(`not retryable (${status})`);
    }
    expect(handleExecute).not.toHaveBeenCalled();
    // D-201 Slice 10N — an in-doubt run runs again only on the owner's try
    // again (`rerun_in_doubt`), never on the restart's mark alone.
    const reviewed = createExecuteWebhookRecipeRunner(deps(async () => anchor('in_doubt')));
    await expect(reviewed.run({ ...request(), rerun_in_doubt: true })).resolves.toBe('completed');
    expect(handleExecute).toHaveBeenCalledTimes(1);
    for (const status of ['killed', 'cancelled'] as const) {
      const runner = createExecuteWebhookRecipeRunner(deps(async () => anchor(status)));
      await expect(runner.run({ ...request(), rerun_in_doubt: true }))
        .resolves.toBe('terminal_non_success');
    }
    expect(handleExecute).toHaveBeenCalledTimes(1);
  });

  it('D-201 Slice 10E — reports a run stopped while the server stops as interrupted; any other stop or failure fails', async () => {
    let draining = true;
    const d = deps(async () => null);
    d.executeDeps.isDraining = () => draining;
    const runner = createExecuteWebhookRecipeRunner(d);
    handleExecute.mockResolvedValue({ success: false, run_terminated: 'killed' });
    await expect(runner.run(request())).resolves.toBe('interrupted');
    // The owner's Stop while the server runs.
    draining = false;
    await expect(runner.run(request())).rejects.toThrow('recipe execution failed');
    // A run that failed on its own while the server stops.
    draining = true;
    handleExecute.mockResolvedValue({ success: false });
    await expect(runner.run(request())).rejects.toThrow('recipe execution failed');
    // A server that cannot say it is stopping.
    delete d.executeDeps.isDraining;
    handleExecute.mockResolvedValue({ success: false, run_terminated: 'killed' });
    await expect(runner.run(request())).rejects.toThrow('recipe execution failed');
  });

  it("D-201 Slice 10J — under the restart's mark, a failure before a new run record says so; the run's own failure does not", async () => {
    const marked = { ...request(), resume_interrupted_run: true };
    const failure = (
      runner: ReturnType<typeof createExecuteWebhookRecipeRunner>,
      input: WebhookRecipeRunRequest = marked,
    ) =>
      runner.run(input).then(() => undefined, (error: unknown) => error);

    // The target changed: it failed before anything ran again.
    const changed = deps(async () => anchor('killed'));
    vi.mocked(changed.executeDeps.recipeStore.getStored).mockReturnValue({
      recipe_id: 'webhook-recipe',
      publisher_id: 'publisher-2',
    } as never);
    const before = await failure(createExecuteWebhookRecipeRunner(changed));
    expect(before).toBeInstanceOf(WebhookRunNotRestartedError);
    expect(String((before as WebhookRunNotRestartedError).original)).toContain('no longer installed');
    // With no mark it is the plain failure, as before.
    expect(await failure(createExecuteWebhookRecipeRunner(changed), request()))
      .not.toBeInstanceOf(WebhookRunNotRestartedError);

    // The run threw before it wrote a record: the restart's `killed` is still there.
    handleExecute.mockRejectedValueOnce(new Error('a store fault before the run'));
    expect(await failure(createExecuteWebhookRecipeRunner(deps(async () => anchor('killed')))))
      .toBeInstanceOf(WebhookRunNotRestartedError);

    // The run started again and failed: a new record replaced `killed`.
    let current = anchor('killed');
    handleExecute.mockImplementationOnce(async () => {
      current = { ...anchor('failed'), started_at: 10, finished_at: 11 };
      return { success: false };
    });
    const own = await failure(createExecuteWebhookRecipeRunner(deps(async () => current)));
    expect(own).not.toBeInstanceOf(WebhookRunNotRestartedError);
    expect(String(own)).toContain('recipe execution failed');

    // A refusal to start goes back as it is: the worker hands it back.
    const refusal = new RpcError('draining', 'The server is restarting.', 503);
    handleExecute.mockRejectedValueOnce(refusal);
    expect(await failure(createExecuteWebhookRecipeRunner(deps(async () => anchor('killed'))))).toBe(refusal);

    // A record that cannot be read: nothing is known to have run again.
    expect(await failure(createExecuteWebhookRecipeRunner(deps(async () => {
      throw new Error('the audit log is closed');
    })))).toBeInstanceOf(WebhookRunNotRestartedError);
  });

  it.each(['pending', 'running'] as const)(
    'does not re-enter an ambiguous %s anchor',
    async (status) => {
      const runner = createExecuteWebhookRecipeRunner(deps(async () => anchor(status)));
      await expect(runner.run(request())).rejects.toThrow(`not retryable (${status})`);
      expect(handleExecute).not.toHaveBeenCalled();
    },
  );

  it('does not reuse an audit anchor created by a non-webhook trigger', async () => {
    const nonWebhook = { ...anchor('succeeded'), trigger_source: 'manual' as const };
    const runner = createExecuteWebhookRecipeRunner(deps(async () => nonWebhook));
    await expect(runner.run(request())).rejects.toThrow('non-webhook run');
    expect(handleExecute).not.toHaveBeenCalled();
  });

  it('fails before execution if the publisher-owned recipe target changed', async () => {
    const d = deps(async () => null);
    vi.mocked(d.executeDeps.recipeStore.getStored).mockReturnValue({
      recipe_id: 'webhook-recipe',
      publisher_id: 'publisher-2',
    } as never);
    const runner = createExecuteWebhookRecipeRunner(d);
    await expect(runner.run(request())).rejects.toThrow('no longer installed');
    expect(handleExecute).not.toHaveBeenCalled();
  });
});

describe('D-201 Slice 10AB — a held try again, through the runner', () => {
  beforeEach(() => {
    handleExecute.mockReset();
  });

  const failure = (code: string, retryable: boolean, details: Record<string, unknown> = {}): AuditEntry => {
    const failed = anchor('failed');
    failed.errors = [{
      error_id: 'failure-fixture',
      code: code as never,
      message: 'failed',
      severity: 'fatal',
      source: { recipe_id: failed.recipe_id, step_id: 'send', ingredient_slug: 'fixture.send' },
      details,
      timestamp: new Date(0).toISOString(),
      retryable,
    }];
    return failed;
  };

  it('a paused record a try again left with no ask under it is the dead letter again; a hold stays one (10AA finding 1)', async () => {
    const paused = anchor('awaiting_approval');
    const settleDiedTryAgain = vi.fn(async () => true);
    const died = createExecuteWebhookRecipeRunner({ ...deps(async () => paused), settleDiedTryAgain } as never);
    await expect(died.run({ ...request(), rerun_in_doubt: true })).resolves.toBe('in_doubt');
    expect(settleDiedTryAgain).toHaveBeenCalledWith(request().run_id, paused);
    const held = createExecuteWebhookRecipeRunner({
      ...deps(async () => paused),
      settleDiedTryAgain: vi.fn(async () => false),
    } as never);
    await expect(held.run(request())).resolves.toBe('awaiting_approval');
    expect(handleExecute).not.toHaveBeenCalled();
  });

  it("the owner's try again of one that failed goes on from where it is held; the worker's retry of a failed run does not (10AA finding 2)", async () => {
    const continueHeldRun = vi.fn(async () => ({ kind: 'completed' as const }));
    const runner = createExecuteWebhookRecipeRunner({
      ...deps(async () => failure('STEP_FAILED', true)),
      continueHeldRun,
    } as never);
    await expect(runner.run({ ...request(), rerun_in_doubt: true })).resolves.toBe('completed');
    expect(continueHeldRun).toHaveBeenCalledTimes(1);
    expect(handleExecute).not.toHaveBeenCalled();
    handleExecute.mockResolvedValue({ success: true });
    await expect(runner.run(request())).resolves.toBe('completed');
    expect(continueHeldRun).toHaveBeenCalledTimes(1);
    expect(handleExecute).toHaveBeenCalledTimes(1);
  });

  it("failed and held again: the dead letter again, unless its door refused it, which ends it as any run's refusal", async () => {
    let after: AuditEntry = anchor('in_doubt');
    const continueHeldRun = vi.fn(async (): Promise<HeldRunOutcome> => ({ kind: 'held_failed', step_id: 'send' }));
    const runner = createExecuteWebhookRecipeRunner({
      ...deps(async () => after),
      continueHeldRun,
    } as never);
    continueHeldRun.mockImplementationOnce(async () => {
      after = failure('STEP_FAILED', true);
      return { kind: 'held_failed', step_id: 'send' };
    });
    await expect(runner.run({ ...request(), rerun_in_doubt: true })).resolves.toBe('in_doubt');
    after = anchor('in_doubt');
    continueHeldRun.mockImplementationOnce(async () => {
      after = failure('RECIPE_POLICY_DENIED', false);
      return { kind: 'held_failed', step_id: 'send' };
    });
    await expect(runner.run({ ...request(), rerun_in_doubt: true })).resolves.toBe('terminal_non_success');
    // Ended without being held (the owner's Stop): the worker's retry reads it.
    after = anchor('in_doubt');
    continueHeldRun.mockImplementationOnce(async () => ({ kind: 'failed' }));
    await expect(runner.run({ ...request(), rerun_in_doubt: true })).rejects.toThrow('recipe execution failed');
    expect(handleExecute).not.toHaveBeenCalled();
  });
});
