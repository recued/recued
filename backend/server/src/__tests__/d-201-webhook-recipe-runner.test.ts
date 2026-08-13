import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '@recued/storage';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import type { WebhookRecipeRunRequest } from '../webhook-recipe-consumer.js';

const { handleExecute } = vi.hoisted(() => ({ handleExecute: vi.fn() }));
vi.mock('../execute-handler.js', () => ({ handleExecute }));

import { createExecuteWebhookRecipeRunner } from '../webhook-recipe-runner.js';

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

  it('treats an unstamped production-wired target as terminal without executing it', async () => {
    const d = {
      ...deps(async () => null),
      resolveDoorRecipe: (recipe: never) => ({ ok: true as const, recipe }),
    };

    await expect(createExecuteWebhookRecipeRunner(d as never).run(request()))
      .resolves.toBe('terminal_non_success');
    expect(handleExecute).not.toHaveBeenCalled();
  });

  it('treats a revoked production-wired door as terminal before a pure recipe can run', async () => {
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
      .resolves.toBe('terminal_non_success');
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

  it.each(['cancelled', 'killed', 'in_doubt'] as const)(
    'closes an already-terminal %s anchor without retrying it',
    async (status) => {
      const runner = createExecuteWebhookRecipeRunner(deps(async () => anchor(status)));
      await expect(runner.run(request())).resolves.toBe('terminal_non_success');
      expect(handleExecute).not.toHaveBeenCalled();
    },
  );

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
